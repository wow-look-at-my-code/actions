import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as util from 'util';
import { createRequire } from 'module';
import * as ts from 'typescript';
import * as yaml from 'yaml';
import { MAIN_FN, transformScript } from './transform';
import { highlightSource } from './highlight';
import { CommentBlock, findCommentBlocks } from './comments';
import { unnamedStepMessage, unnamedSteps, WorkflowDoc } from './step-name';

type ShellArg = string | number | boolean | null | undefined | string[];

/**
 * A captured output stream: a `String` object that also carries a `.json()`
 * helper, so `output.stdout.json()` parses it while every ordinary string
 * operation (`.trim()`, `.includes()`, concatenation, template literals) still
 * works. Typed as `string & {...}` so it stays assignable to `string`.
 *
 * The runtime value is a boxed `String`, so `typeof` is `'object'` and a strict
 * `===` against a string literal is `false` — use `.trim()`, loose `==`, or
 * `String(stream)` when a primitive is needed for a comparison.
 */
// eslint-disable-next-line local/no-callable-primitive-intersection -- known: $ output is a boxed branded-primitive (the documented TS footgun); pending the primitive-string redesign
type OutputStream = string & { json<T = unknown>(): T };

// eslint-disable-next-line @typescript-eslint/no-wrapper-object-types -- known: $ output is a boxed branded-primitive (the documented TS footgun); pending the primitive-string redesign
function streamJson<T = unknown>(this: String): T {
	return JSON.parse(this.toString()) as T;
}

/** Box a captured stream string and attach the `.json()` helper. */
function makeStream(value: string): OutputStream {
	// eslint-disable-next-line no-new-wrappers -- known: $ output is a boxed branded-primitive (the documented TS footgun); pending the primitive-string redesign
	return Object.assign(new String(value), { json: streamJson }) as unknown as OutputStream;
}

/** Remove a single trailing newline (`\n` or `\r\n`) — shell `$(...)`-style. */
function trimTrailingNewline(s: string): string {
	return s.replace(/\r?\n$/, '');
}

/**
 * Result of awaiting a `$` command: the captured streams plus the exit code.
 * `toString()` returns stdout (trailing newline trimmed) so a command's output
 * can be string-coerced inline, while `stdout`/`stderr` are the raw streams,
 * each carrying a `.json()` helper.
 */
class ProcessOutput {
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly exitCode: number;

	constructor(out: exec.ExecOutput) {
		this.stdout = makeStream(out.stdout);
		this.stderr = makeStream(out.stderr);
		this.exitCode = out.exitCode;
	}

	/** stdout with a single trailing newline (`\n` or `\r\n`) removed. */
	toString(): string {
		return trimTrailingNewline(this.stdout);
	}
}

/**
 * Thrown when a `$` command exits non-zero (unless `.nothrow()` was chained).
 * Carries the captured `stdout`/`stderr`/`exitCode` so a `catch` can inspect
 * the failure without re-running the command.
 */
class ProcessError extends Error {
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly exitCode: number;

	constructor(command: string, output: ProcessOutput) {
		const detail = output.stderr.trim();
		super(`\`$\` command failed with exit code ${output.exitCode}: ${command}${detail ? `\n${detail}` : ''}`);
		this.name = 'ProcessError';
		this.stdout = output.stdout;
		this.stderr = output.stderr;
		this.exitCode = output.exitCode;
	}
}

/**
 * Lazy accessor for one stream of a `$` command that has not run yet — the
 * value of the builder's `.stdout` / `.stderr` getters. Awaiting it runs the
 * command and resolves to that stream (an `OutputStream`); `.json()` / `.text()`
 * are paren-free terminals. This is what makes `await $`cmd`.stdout.json()` work
 * without the `(await ...)` wrapper (`await` binds looser than `.`).
 */
class StreamPromise implements PromiseLike<OutputStream> {
	constructor(
		private readonly run: () => Promise<ProcessOutput>,
		private readonly pick: (o: ProcessOutput) => OutputStream,
	) {}

	private resolve(): Promise<OutputStream> {
		return this.run().then(this.pick);
	}

	then<T = OutputStream, R = never>(
		onfulfilled?: ((v: OutputStream) => T | PromiseLike<T>) | null,
		onrejected?: ((e: unknown) => R | PromiseLike<R>) | null,
	): Promise<T | R> {
		return this.resolve().then(onfulfilled, onrejected);
	}

	/** Run the command and resolve to this stream parsed as JSON. */
	json<T = unknown>(): Promise<T> {
		return this.resolve().then((s) => s.json<T>());
	}

	/** Run the command and resolve to this stream with a trailing newline trimmed. */
	text(): Promise<string> {
		return this.resolve().then(trimTrailingNewline);
	}
}

class ExecBuilder implements PromiseLike<ProcessOutput> {
	private cmd: string;
	private args: string[];
	private opts: exec.ExecOptions;
	private throwOnNonZero: boolean;

	constructor(cmd: string, args: string[], opts: exec.ExecOptions = {}, throwOnNonZero = true) {
		this.cmd = cmd;
		this.args = args;
		this.opts = opts;
		this.throwOnNonZero = throwOnNonZero;
	}

	private with(patch: Partial<exec.ExecOptions>, throwOnNonZero = this.throwOnNonZero): ExecBuilder {
		return new ExecBuilder(this.cmd, this.args, { ...this.opts, ...patch }, throwOnNonZero);
	}

	/** Pipe data to the command's stdin. */
	input(data: Buffer | string): ExecBuilder {
		return this.with({ input: Buffer.isBuffer(data) ? data : Buffer.from(data) });
	}

	/** Set the working directory. */
	cwd(dir: string): ExecBuilder {
		return this.with({ cwd: dir });
	}

	/** Suppress streaming stdout/stderr to the live log (still captured). */
	silent(): ExecBuilder {
		return this.with({ silent: true });
	}

	/**
	 * Merge/override environment variables for this command. @actions/exec
	 * *replaces* the environment when `env` is set, so seed from the current
	 * process env (or a prior `.env()`) and layer the overrides on top.
	 */
	env(vars: Record<string, string>): ExecBuilder {
		const base = this.opts.env ?? (process.env as Record<string, string>);
		return this.with({ env: { ...base, ...vars } });
	}

	/** Resolve even on a non-zero exit; read `exitCode` instead of catching. */
	nothrow(): ExecBuilder {
		return this.with({}, false);
	}

	/**
	 * Lazy stdout accessor. Awaitable on its own (`await $`cmd`.stdout`) and the
	 * reason `await $`cmd`.stdout.json()` works paren-free.
	 */
	get stdout(): StreamPromise {
		return new StreamPromise(() => this.run(), (o) => o.stdout);
	}

	/** Lazy stderr accessor — `await $`cmd`.stderr` / `.stderr.json()`. */
	get stderr(): StreamPromise {
		return new StreamPromise(() => this.run(), (o) => o.stderr);
	}

	/**
	 * Run the command and resolve to its stdout parsed as JSON. A terse stdout
	 * shortcut equivalent to `.stdout.json()`: `await $`...`.json()`.
	 */
	json<T = unknown>(): Promise<T> {
		return this.stdout.json<T>();
	}

	/**
	 * Run the command and resolve to its stdout as a string with a single
	 * trailing newline trimmed (like `toString()`): `await $`...`.text()`.
	 */
	text(): Promise<string> {
		return this.stdout.text();
	}

	private async run(): Promise<ProcessOutput> {
		// Always capture and never let getExecOutput throw on a non-zero exit
		// (ignoreReturnCode), so stdout/stderr survive a failure; the throw
		// decision is made here so the error can carry the captured output.
		const raw = await exec.getExecOutput(this.cmd, this.args, { ...this.opts, ignoreReturnCode: true });
		const output = new ProcessOutput(raw);
		if (this.throwOnNonZero && raw.exitCode !== 0) {
			throw new ProcessError([this.cmd, ...this.args].join(' '), output);
		}
		return output;
	}

	then<T = ProcessOutput, R = never>(
		onfulfilled?: ((v: ProcessOutput) => T | PromiseLike<T>) | null,
		onrejected?: ((e: unknown) => R | PromiseLike<R>) | null,
	): Promise<T | R> {
		return this.run().then(onfulfilled, onrejected);
	}
}

function $(strings: TemplateStringsArray, ...values: ShellArg[]): ExecBuilder {
	const args: string[] = [];
	for (let i = 0; i < strings.length; i++) {
		for (const token of strings[i].split(/\s+/)) {
			if (token) args.push(token);
		}
		if (i < values.length) {
			const val = values[i];
			if (val === null || val === undefined || val === false || val === '') continue;
			if (val === true) continue;
			if (Array.isArray(val)) {
				for (const v of val) { if (v) args.push(v); }
			} else {
				args.push(String(val));
			}
		}
	}
	if (args.length === 0) throw new Error('$`...` template produced no arguments');
	const [cmd, ...cmdArgs] = args;
	return new ExecBuilder(cmd, cmdArgs);
}

// dist/ layout produced by `just build`:
//   dist/index.js                  (bundled action)
//   dist/lib.es*.d.ts              (TypeScript standard libs)
//   dist/types/node_modules/...    (mirrored types for module resolution)
const DIST_DIR = __dirname;
const TYPES_DIR = path.join(DIST_DIR, 'types');
// Virtual file for type-checking. Located under TYPES_DIR so node module
// resolution finds dist/types/node_modules/* by walking up.
const VIRTUAL_FILE = path.join(TYPES_DIR, '__user-script.ts');
// The ambient declarations for the injected helpers are served to tsc as their
// own in-memory global script file (a .d.ts with no top-level import/export),
// not prepended into the user's module: that keeps user line numbers intact and
// lets a user-level `import * as path from 'node:path'` legally shadow the
// injected `path` instead of colliding with a same-file declaration.
const GLOBALS_VIRTUAL_FILE = path.join(TYPES_DIR, '__globals.d.ts');

const GLOBALS_DTS = fs.readFileSync(path.join(DIST_DIR, 'globals.d.ts'), 'utf-8');

interface WorkflowContexts {
	github: unknown;
	env: unknown;
	runner: unknown;
	job: unknown;
	steps: unknown;
	needs: unknown;
	vars: unknown;
	secrets: unknown;
	inputs: unknown;
	strategy: unknown;
	matrix: unknown;
}

// Returns parsed JSON, or undefined if the input was unset / blank.
function maybeParseJson(name: string): unknown {
	const raw = core.getInput(name);
	if (!raw || !raw.trim()) return undefined;
	try {
		return JSON.parse(raw);
	} catch (e) {
		throw new Error(`Input '${name}' is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// Like maybeParseJson, but defaults to {} when unset (for contexts the runner
// never exposes — vars, secrets, steps, needs, inputs, strategy, matrix).
function parseOptionalContext(name: string): unknown {
	return maybeParseJson(name) ?? {};
}

function deriveGithubContext(): Record<string, unknown> {
	const eventPath = process.env.GITHUB_EVENT_PATH;
	let event: unknown = {};
	if (eventPath) {
		try {
			event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
		} catch {
			// fall through to empty event
		}
	}
	// Mirror the shape of the workflow `github` context. Numeric fields are
	// left as the strings the runner provides — converting silently could
	// surprise a script comparing against ${{ github.run_id }} substitutions.
	return {
		event,
		event_name: process.env.GITHUB_EVENT_NAME,
		event_path: eventPath,
		actor: process.env.GITHUB_ACTOR,
		actor_id: process.env.GITHUB_ACTOR_ID,
		triggering_actor: process.env.GITHUB_TRIGGERING_ACTOR,
		repository: process.env.GITHUB_REPOSITORY,
		repository_id: process.env.GITHUB_REPOSITORY_ID,
		repository_owner: process.env.GITHUB_REPOSITORY_OWNER,
		repository_owner_id: process.env.GITHUB_REPOSITORY_OWNER_ID,
		run_id: process.env.GITHUB_RUN_ID,
		run_number: process.env.GITHUB_RUN_NUMBER,
		run_attempt: process.env.GITHUB_RUN_ATTEMPT,
		retention_days: process.env.GITHUB_RETENTION_DAYS,
		workflow: process.env.GITHUB_WORKFLOW,
		workflow_ref: process.env.GITHUB_WORKFLOW_REF,
		workflow_sha: process.env.GITHUB_WORKFLOW_SHA,
		job: process.env.GITHUB_JOB,
		job_workflow_sha: process.env.GITHUB_JOB_WORKFLOW_SHA,
		sha: process.env.GITHUB_SHA,
		ref: process.env.GITHUB_REF,
		ref_name: process.env.GITHUB_REF_NAME,
		ref_type: process.env.GITHUB_REF_TYPE,
		ref_protected: process.env.GITHUB_REF_PROTECTED,
		head_ref: process.env.GITHUB_HEAD_REF,
		base_ref: process.env.GITHUB_BASE_REF,
		workspace: process.env.GITHUB_WORKSPACE,
		api_url: process.env.GITHUB_API_URL,
		server_url: process.env.GITHUB_SERVER_URL,
		graphql_url: process.env.GITHUB_GRAPHQL_URL,
		action: process.env.GITHUB_ACTION,
		action_path: process.env.GITHUB_ACTION_PATH,
		action_ref: process.env.GITHUB_ACTION_REF,
		action_repository: process.env.GITHUB_ACTION_REPOSITORY,
		action_status: process.env.GITHUB_ACTION_STATUS,
		secret_source: process.env.GITHUB_SECRET_SOURCE,
		token: process.env.GITHUB_TOKEN,
		path: process.env.GITHUB_PATH,
		env: process.env.GITHUB_ENV,
		output: process.env.GITHUB_OUTPUT,
		state: process.env.GITHUB_STATE,
		step_summary: process.env.GITHUB_STEP_SUMMARY,
	};
}

function deriveRunnerContext(): Record<string, unknown> {
	return {
		os: process.env.RUNNER_OS,
		arch: process.env.RUNNER_ARCH,
		name: process.env.RUNNER_NAME,
		environment: process.env.RUNNER_ENVIRONMENT,
		temp: process.env.RUNNER_TEMP,
		tool_cache: process.env.RUNNER_TOOL_CACHE,
		debug: process.env.RUNNER_DEBUG,
	};
}

function deriveJobContext(): Record<string, unknown> {
	// `job.container` and `job.services` are only available via the runner's
	// expression substitution, never to the action process. Surface what we
	// can — the job id — and leave a placeholder status.
	return {
		status: process.env.GITHUB_ACTION_STATUS ?? 'success',
	};
}

function readContexts(): WorkflowContexts {
	return {
		// Auto-derived from env vars and the event-payload file. An explicit
		// JSON input (when present) wins, mainly for tests / dry runs.
		github: maybeParseJson('github') ?? deriveGithubContext(),
		runner: maybeParseJson('runner') ?? deriveRunnerContext(),
		job: maybeParseJson('job') ?? deriveJobContext(),
		// Workflow `env:` context: GitHub doesn't distinguish those vars from
		// system env in the action's process, so we default to all of process.env.
		env: maybeParseJson('env') ?? { ...process.env },
		// The runner never exposes these contexts to action processes — they
		// only exist as workflow-expression substitutions. Default to {}; the
		// caller passes JSON only when they actually need them.
		steps: parseOptionalContext('steps'),
		needs: parseOptionalContext('needs'),
		vars: parseOptionalContext('vars'),
		secrets: parseOptionalContext('secrets'),
		inputs: parseOptionalContext('inputs'),
		strategy: parseOptionalContext('strategy'),
		matrix: parseOptionalContext('matrix'),
	};
}

// lib.dom is opt-in per step. It declares hundreds of browser globals whose
// names collide with ordinary identifiers, so a script that does not touch the
// DOM type-checks more strictly without it.
function domEnabled(): boolean {
	const raw = core.getInput('dom').trim().toLowerCase();
	if (raw === '' || raw === 'false') return false;
	if (raw === 'true') return true;
	throw new Error(`Input 'dom' must be 'true' or 'false', got '${core.getInput('dom')}'.`);
}

function libFiles(): string[] {
	const libs = ['lib.es2022.d.ts'];
	// dom.iterable comes with it: without it a NodeList is not iterable, which
	// is the first thing browser-side code does with one.
	if (domEnabled()) libs.push('lib.dom.d.ts', 'lib.dom.iterable.d.ts');
	return libs;
}

function baseCompilerOptions(): ts.CompilerOptions {
	return {
		target: ts.ScriptTarget.ES2022,
		module: ts.ModuleKind.ES2022,
		moduleResolution: ts.ModuleResolutionKind.Node10,
		strict: true,
		esModuleInterop: true,
		skipLibCheck: true,
		forceConsistentCasingInFileNames: true,
		resolveJsonModule: true,
		allowSyntheticDefaultImports: true,
		lib: libFiles(),
		types: ['node'],
		typeRoots: [path.join(TYPES_DIR, 'node_modules', '@types')],
		baseUrl: TYPES_DIR,
	};
}

// GitHub evaluates every ${{ ... }} expression into the script text before this
// action runs, so an input read the documented way -- `const a = '${{ inputs.assert }}'`
// -- reaches tsc as a plain string literal. Every comparison against it is then
// literal-vs-literal, and TS2367 calls it unintentional because THIS run's value
// does not match. The value differs per run, and the check cannot tell a
// substituted literal from a hand-written one, so it is unsound in this action
// and reports only false positives.
const SUBSTITUTION_UNSOUND_CODES = new Set([
	2367, // This comparison appears to be unintentional because the types X and Y have no overlap.
]);

function typeCheck(source: string): readonly ts.Diagnostic[] {
	const opts: ts.CompilerOptions = { ...baseCompilerOptions(), noEmit: true };

	const sources = new Map<string, string>([
		[VIRTUAL_FILE, source],
		[GLOBALS_VIRTUAL_FILE, GLOBALS_DTS],
	]);
	const host = ts.createCompilerHost(opts);
	const originalReadFile = host.readFile.bind(host);
	const originalFileExists = host.fileExists.bind(host);
	const originalGetSourceFile = host.getSourceFile.bind(host);

	host.readFile = (fileName) => sources.get(fileName) ?? originalReadFile(fileName);
	host.fileExists = (fileName) => sources.has(fileName) || originalFileExists(fileName);
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const synthetic = sources.get(fileName);
		if (synthetic !== undefined) {
			return ts.createSourceFile(fileName, synthetic, languageVersion, true);
		}
		return originalGetSourceFile(fileName, languageVersion, onError, shouldCreate);
	};

	const program = ts.createProgram({
		rootNames: [VIRTUAL_FILE, GLOBALS_VIRTUAL_FILE],
		options: opts,
		host,
	});

	// Syntactic/semantic diagnostics are scoped to the user's file: the globals
	// file is the action's own (and skipLibCheck'd), and collecting program-wide
	// would surface its diagnostics under a misleading user-facing label.
	const userFile = program.getSourceFile(VIRTUAL_FILE);
	return [
		...program.getSyntacticDiagnostics(userFile),
		...program.getSemanticDiagnostics(userFile),
		...program.getGlobalDiagnostics(),
	].filter((d) => !SUBSTITUTION_UNSOUND_CODES.has(d.code));
}

// Maps an emitted (transformed) 0-based line back to a 1-based user-script
// line. Synthetic wrapper lines have no source line; fall back to the nearest
// preceding user line so errors like "'}' expected" still point somewhere sane.
function toUserLine(lineMap: number[], outLine: number): number {
	for (let i = Math.min(outLine, lineMap.length - 1); i >= 0; i--) {
		if (lineMap[i] >= 0) return lineMap[i] + 1;
	}
	return 1;
}

function formatDiagnostic(d: ts.Diagnostic, label: string, lineMap: number[]): string {
	const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
	if (d.file && d.start !== undefined) {
		const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
		if (d.file.fileName !== VIRTUAL_FILE) {
			// Diagnostics are scoped to the user file; anything else (e.g. from
			// getGlobalDiagnostics) is labeled by its own name, unmapped.
			return `${path.basename(d.file.fileName)}:${line + 1}:${character + 1}: error TS${d.code}: ${message}`;
		}
		return `${label}:${toUserLine(lineMap, line)}:${character + 1}: error TS${d.code}: ${message}`;
	}
	return `error TS${d.code}: ${message}`;
}

// The count alone reads as a threshold: collapse a 3-line block to 2 and the
// error repeats. Keep the sentence naming the real limit.
function formatCommentBlock(b: CommentBlock, label: string): string {
	const count = b.endLine - b.startLine + 1;
	return `${label}:${b.startLine}:1: error: ${count} consecutive \`//\` comment lines (${b.startLine}-${b.endLine}). The limit is ONE: any two adjacent \`//\` lines fail, so shortening the block does not help. Stacked line comments are prose, not code — say it in a single line, or delete it.`;
}

function transpile(source: string): string {
	const result = ts.transpileModule(source, {
		compilerOptions: {
			target: ts.ScriptTarget.ES2022,
			module: ts.ModuleKind.CommonJS,
			esModuleInterop: true,
			allowSyntheticDefaultImports: true,
		},
		fileName: VIRTUAL_FILE,
		reportDiagnostics: false,
	});
	return result.outputText;
}

async function execute(transpiledJs: string, ctx: WorkflowContexts, baseDir: string, githubToken: string): Promise<unknown> {
	// The pre-authenticated `octokit` instance is built lazily from the
	// `github-token` action input (default ${{ github.token }}), mirroring how
	// actions/github-script obtains the automatic token. The runner does NOT put
	// GITHUB_TOKEN in the action process env, so reading process.env.GITHUB_TOKEN
	// would leave octokit unauthenticated (getOctokit('') throws on first use).
	let _preAuth: ReturnType<typeof github.getOctokit> | null = null;
	const octokitProxy = new Proxy(
		function deprecatedOctokit(token: string, options?: Parameters<typeof github.getOctokit>[1]) {
			core.warning('octokit(token) is deprecated; use the pre-authenticated octokit instance directly, or getOctokit(token) for a custom token');
			return github.getOctokit(token, options);
		},
		{
			get(_target, prop) {
				if (!_preAuth) _preAuth = github.getOctokit(githubToken);
				return Reflect.get(_preAuth, prop);
			},
		}
	);
	Object.assign(globalThis, {
		$, core, exec, io,
		octokit: octokitProxy,
		getOctokit: github.getOctokit,
		context: github.context,
		github: ctx.github, env: ctx.env, runner: ctx.runner,
		job: ctx.job, steps: ctx.steps, needs: ctx.needs,
		vars: ctx.vars, secrets: ctx.secrets, inputs: ctx.inputs,
		strategy: ctx.strategy, matrix: ctx.matrix,
		fs, path, os, child_process, util,
	});

	// yaml is bundled here, so a script gets it on every runner. Shelling out to
	// yq instead fails on Windows, which has no yq on PATH.
	const actionModules: Record<string, unknown> = {
		'@actions/core': core,
		'@actions/github': github,
		'@actions/exec': exec,
		'@actions/io': io,
		yaml,
	};

	const NodeModule = require('module');
	const origResolve = NodeModule._resolveFilename;
	const workspaceDir = process.env.GITHUB_WORKSPACE;

	// require.resolve() goes through this same hook, so a request nothing can
	// resolve used to re-enter the fallback until the stack overflowed. The
	// original resolver is restored across the call, which turns that into the
	// ordinary "Cannot find module" the caller needs to read.
	const patched = function (this: unknown, request: string, parent: unknown, isMain: boolean, options: unknown) {
		if (request in actionModules) return request;
		try {
			return origResolve.call(this, request, parent, isMain, options);
		} catch (e) {
			if (!workspaceDir) throw e;
			NodeModule._resolveFilename = origResolve;
			try {
				return createRequire(path.join(workspaceDir, 'noop.js')).resolve(request);
			} finally {
				NodeModule._resolveFilename = patched;
			}
		}
	};
	NodeModule._resolveFilename = patched;

	for (const [name, mod] of Object.entries(actionModules)) {
		// A cache entry the loader only ever reads `exports` off. The rest of
		// NodeModule is filled in to keep the shape recognizable, so the cast
		// stands in for the fields nothing here touches.
		require.cache[name] = {
			id: name, filename: name, loaded: true, exports: mod,
			parent: null, children: [], paths: [],
		} as unknown as NodeJS.Module;
	}

	const scriptFilename = path.join(baseDir, `.user-script-${process.pid}-${Date.now()}.js`);
	const scriptRequire = createRequire(scriptFilename);

	try {
		const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
		const fn = new AsyncFunction('require', 'exports', 'module', '__filename', '__dirname', transpiledJs);
		const mod = { exports: {} as Record<string, unknown> };
		// Running the transpiled module executes the hoisted module-scope
		// statements (imports become require() calls, export initializers run)
		// and defines __main on exports. The rest of the user's code lives in
		// __main's body — invoke it and use its resolved value as the result
		// (so `return <value>` works).
		await fn(scriptRequire, mod.exports, mod, scriptFilename, baseDir);
		const main = mod.exports[MAIN_FN];
		if (typeof main !== 'function') {
			// buildSource always wraps the script in __main; only reachable if the
			// user reassigned module.exports. Treat as "no result".
			return undefined;
		}
		return await (main as () => Promise<unknown>)();
	} finally {
		NodeModule._resolveFilename = origResolve;
		for (const name of Object.keys(actionModules)) delete require.cache[name];
	}
}

function readUserScript(): { script: string; label: string; dir: string; inline: boolean } {
	const inline = core.getInput('script');
	const file = core.getInput('file');

	if (inline && file) {
		throw new Error("Inputs 'script' and 'file' are mutually exclusive — provide one or the other.");
	}
	if (!inline && !file) {
		throw new Error("Either 'script' or 'file' must be provided.");
	}

	if (file) {
		const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
		const resolved = path.resolve(workspace, file);
		if (!fs.existsSync(resolved)) {
			throw new Error(`File not found: ${resolved}`);
		}
		return { script: fs.readFileSync(resolved, 'utf-8'), label: file, dir: path.dirname(resolved), inline: false };
	}

	return { script: inline, label: 'script', dir: process.env.GITHUB_WORKSPACE ?? process.cwd(), inline: true };
}

// Reads the running workflow to find this step and check it carries a `name:`.
// A step reached through a composite action is not in that file, and neither is
// anything outside a workflow run, so both cases return no findings.
async function unnamedStepPositions(): Promise<{workflow: string; job: string; positions: number[]}> {
	const ref = process.env.GITHUB_WORKFLOW_REF;
	const job = process.env.GITHUB_JOB;
	const workspace = process.env.GITHUB_WORKSPACE;
	const none = {workflow: '', job: job ?? '', positions: []};
	if (!ref || !job || !workspace) return none;

	const workflow = ref.split('@')[0].split('/').slice(2).join('/');
	const file = path.join(workspace, workflow);
	if (!workflow || !fs.existsSync(file)) return none;

	const doc = yaml.parse(fs.readFileSync(file, 'utf-8')) as WorkflowDoc;
	return {workflow, job, positions: unnamedSteps(doc, job)};
}

async function run(): Promise<void> {
	const { script: userScript, label, dir, inline } = readUserScript();

	// Everything up to execution shares one group: the source echo plus a line
	// each from the type-check and the transpile. Separate groups for two lines
	// of "it worked" are three things to expand instead of one.
	//
	// The source is syntax-highlighted with raw ANSI escapes (the Actions log
	// viewer renders 24-bit color; plain-text fallback on failure), and is
	// echoed FIRST so a later throw still leaves the script in the log.
	core.startGroup('Compiling script');
	core.info(highlightSource(trimTrailingNewline(userScript)));

	// An inline `script:` may not carry a paragraph of commentary: two `//`-only
	// lines in a row is an essay in progress, and a workflow file is not where
	// prose belongs. A `file:` input is ordinary checked-in source and exempt.
	// A violation here defers the failure: the type-check and the script itself
	// still run to completion (so a caller sees everything wrong in one pass,
	// not one error per re-run), and the step only fails at the very end. A
	// type-check or runtime error is unrelated and still fails immediately, same
	// as before.
	const commentBlocks = inline ? findCommentBlocks(userScript) : [];
	for (const b of commentBlocks) {
		core.error(formatCommentBlock(b, label));
	}

	// Deferred with the comment gate, for the same reason: the script still runs,
	// so one pass shows everything wrong instead of one error per re-run.
	const unnamed = await unnamedStepPositions();
	if (unnamed.positions.length > 0) {
		core.error(unnamedStepMessage(unnamed.workflow, unnamed.job, unnamed.positions));
	}

	const { text: source, lineMap } = transformScript(userScript);
	const diagnostics = typeCheck(source);
	if (diagnostics.length > 0) {
		for (const d of diagnostics) {
			core.error(formatDiagnostic(d, label, lineMap));
		}
		core.endGroup();
		core.setFailed(`TypeScript validation failed with ${diagnostics.length} error(s).`);
		return;
	}
	core.info('Type-check passed.');

	const js = transpile(source);
	core.info(`Transpiled output: ${js.length} bytes`);
	core.endGroup();

	const ctx = readContexts();
	// Token for the injected `octokit` (and the default getOctokit() token).
	// Defaults to ${{ github.token }} via the action input, so the common case is
	// authenticated with no caller plumbing.
	const githubToken = core.getInput('github-token');

	core.startGroup('Executing script');
	const result = await execute(js, ctx, dir, githubToken);
	core.endGroup();

	if (result !== undefined) {
		core.setOutput('result', JSON.stringify(result));
	}

	// The step ran to completion; a comment-block violation only fails it now,
	// after the type-check and execution results are already visible.
	if (commentBlocks.length > 0) {
		core.setFailed(`Comment check failed: ${commentBlocks.length} block(s) of consecutive \`//\` comment lines.`);
	}
	if (unnamed.positions.length > 0) {
		core.setFailed(`Step name check failed: ${unnamed.positions.length} typescript step(s) in job '${unnamed.job}' carry no \`name:\`.`);
	}
}

run().catch((err) => {
	core.setFailed(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
