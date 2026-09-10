// Ambient declarations injected by the typescript action.

declare const core: typeof import('@actions/core');
declare const exec: typeof import('@actions/exec');
declare const io: typeof import('@actions/io');

type ShellArg = string | number | boolean | null | undefined | string[];

/**
 * A captured output stream from a `$` command: a string that also carries a
 * `.json()` helper. Every ordinary string operation still works (`.trim()`,
 * `.split()`, `.includes()`, concatenation, template literals); `.json()`
 * parses the stream as JSON.
 *
 * Note: at runtime this is a boxed `String` object, so `typeof` is `'object'`
 * and a strict `===` against a string literal is `false` — use `.trim()`, loose
 * `==`, or `String(stream)` when you need the primitive for a comparison.
 */
// eslint-disable-next-line local/no-callable-primitive-intersection -- known: $ output is a boxed branded-primitive (the documented TS footgun); pending the primitive-string redesign
type OutputStream = string & {
	/**
	 * Parse this stream as JSON (throws if it is not valid JSON). Name the
	 * shape you expect -- `json<{ tag: string }>()` -- or narrow the `unknown`
	 * the parse returns.
	 */
	json<T = unknown>(): T;
};

/**
 * Resolved result of awaiting a `$` command (zx-style). `toString()` returns
 * stdout with a single trailing newline trimmed, so the output can be
 * string-coerced inline (e.g. in a template literal); the `stdout` property is
 * the raw, untrimmed output.
 */
interface ProcessOutput {
	/** The command's full stdout (untrimmed), with a `.json()` helper. */
	stdout: OutputStream;
	/** The command's full stderr, with a `.json()` helper. */
	stderr: OutputStream;
	/** The process exit code. */
	exitCode: number;
	/** stdout with a single trailing newline (`\n` or `\r\n`) removed. */
	toString(): string;
}

/**
 * Lazy accessor for one stream of a not-yet-run `$` command — the value of the
 * builder's `.stdout` / `.stderr`. Awaiting it runs the command and resolves to
 * that stream (an {@link OutputStream}); `.json()` / `.text()` are paren-free
 * terminals. This is what lets `await $`cmd`.stdout.json()` work directly,
 * without the `(await ...)` wrapper that `await`'s loose precedence otherwise
 * forces.
 */
interface StreamPromise extends PromiseLike<OutputStream> {
	/** Run the command and resolve to this stream parsed as JSON. */
	json<T = unknown>(): Promise<T>;
	/** Run the command and resolve to this stream with a trailing newline trimmed. */
	text(): Promise<string>;
}

/**
 * Thenable command builder returned by `$`. Awaiting executes the command and
 * resolves to a {@link ProcessOutput}. Chain methods to set options before
 * awaiting.
 */
interface ExecBuilder extends PromiseLike<ProcessOutput> {
	/** Pipe data to the command's stdin. */
	input(data: Buffer | string): ExecBuilder;
	/** Set the working directory. */
	cwd(dir: string): ExecBuilder;
	/** Suppress streaming stdout/stderr to the live log (still captured). */
	silent(): ExecBuilder;
	/** Merge/override environment variables for this command. */
	env(vars: Record<string, string>): ExecBuilder;
	/** Resolve even on a non-zero exit; read `exitCode` instead of catching. */
	nothrow(): ExecBuilder;
	/**
	 * Lazy stdout accessor: awaitable on its own (`await $`cmd`.stdout`) and the
	 * reason `await $`cmd`.stdout.json()` works without the `(await ...)` wrapper.
	 */
	readonly stdout: StreamPromise;
	/** Lazy stderr accessor — `await $`cmd`.stderr` / `.stderr.json()`. */
	readonly stderr: StreamPromise;
	/** Terse stdout shortcut equivalent to `.stdout.json()`: `await $`...`.json()`. */
	json<T = unknown>(): Promise<T>;
	/** Terse stdout shortcut equivalent to `.stdout.text()`: `await $`...`.text()`. */
	text(): Promise<string>;
}

/**
 * Execute a command via tagged template. Static parts are split by whitespace;
 * interpolated values are passed as individual arguments (never shell-split).
 *
 * - string/number -> single argument
 * - string[] -> expanded as multiple arguments
 * - falsy (false, null, undefined, '') -> skipped
 *
 * Awaiting resolves to a {@link ProcessOutput} (`stdout`, `stderr`, `exitCode`).
 * Throws on a non-zero exit by default (the thrown error carries the captured
 * `stdout`/`stderr`/`exitCode`); chain `.nothrow()` to read `exitCode` instead.
 * Chain .input()/.cwd()/.silent()/.env()/.nothrow() before awaiting.
 */
declare function $(strings: TemplateStringsArray, ...values: ShellArg[]): ExecBuilder;
declare const fs: typeof import('fs');
declare const path: typeof import('path');
declare const os: typeof import('os');
declare const child_process: typeof import('child_process');
declare const util: typeof import('util');

declare const context: import('@actions/github/lib/context').Context;

/**
 * The client `@actions/github` hands back, typed as that package types it. So
 * `octokit.rest.issues.createComment` takes the arguments that endpoint takes
 * and nothing else, and a call to an endpoint GitHub does not have is a
 * compile error rather than a 404 at run time.
 */
type OctokitInstance = ReturnType<typeof import('@actions/github').getOctokit>;
type OctokitOptions = Parameters<typeof import('@actions/github').getOctokit>[1];

interface OctokitCallable extends OctokitInstance {
	/** @deprecated Use the pre-authenticated `octokit` instance directly, or `getOctokit(token)` for a custom token. */
	(token: string, options?: OctokitOptions): OctokitInstance;
}
declare const octokit: OctokitCallable;
declare function getOctokit(token: string, options?: OctokitOptions): OctokitInstance;

interface RunnerContext {
	os: 'Linux' | 'macOS' | 'Windows' | string;
	arch: 'X86' | 'X64' | 'ARM' | 'ARM64' | string;
	name: string;
	environment: 'github-hosted' | 'self-hosted' | string;
	tool_cache: string;
	temp: string;
	debug: string;
}

interface JobContext {
	status: 'success' | 'failure' | 'cancelled' | string;
	container?: { id: string; network: string };
	services?: Record<string, { id: string; ports: Record<string, string>; network: string }>;
}

interface StrategyContext {
	fail_fast: boolean;
	job_index: number;
	job_total: number;
	max_parallel: number;
}

interface StepResult {
	conclusion: 'success' | 'failure' | 'cancelled' | 'skipped' | string;
	outcome: 'success' | 'failure' | 'cancelled' | 'skipped' | string;
	outputs: Record<string, string>;
}

interface NeedsResult {
	result: 'success' | 'failure' | 'cancelled' | 'skipped' | string;
	outputs: Record<string, string>;
}

/**
 * The workflow `github` context, field for field as the action builds it from
 * the runner's environment (see deriveGithubContext in src/index.ts). Numeric
 * fields stay the strings the runner provides, so a comparison against a
 * `${{ github.run_id }}` substitution still matches.
 *
 * A field the runner sets on every run is a `string`. A field that depends on
 * the event, or that the runner withholds from the action process, is
 * `string | undefined` and has to be checked before use.
 */
interface GitHubContext {
	/** The webhook payload that started the run, parsed from GITHUB_EVENT_PATH. */
	event: import('@actions/github/lib/interfaces').WebhookPayload;
	event_name: string;
	event_path: string;
	actor: string;
	actor_id: string;
	triggering_actor: string;
	repository: string;
	repository_id: string;
	repository_owner: string;
	repository_owner_id: string;
	run_id: string;
	run_number: string;
	run_attempt: string;
	retention_days: string;
	workflow: string;
	workflow_ref: string;
	workflow_sha: string;
	job: string;
	job_workflow_sha: string;
	sha: string;
	ref: string;
	ref_name: string;
	ref_type: string;
	ref_protected: string;
	/** Set on a pull_request event only. */
	head_ref: string | undefined;
	/** Set on a pull_request event only. */
	base_ref: string | undefined;
	workspace: string;
	api_url: string;
	server_url: string;
	graphql_url: string;
	action: string;
	action_path: string;
	action_ref: string;
	action_repository: string;
	action_status: string;
	secret_source: string;
	/**
	 * The runner keeps GITHUB_TOKEN out of the action process, so this is
	 * normally undefined. The pre-authenticated `octokit` is the way to reach
	 * the API; pass `${{ github.token }}` in explicitly if a raw token is needed.
	 */
	token: string | undefined;
	path: string;
	env: string;
	output: string;
	state: string;
	step_summary: string;
}

declare const github: GitHubContext;
declare const env: Record<string, string>;
declare const runner: RunnerContext;
declare const job: JobContext;
declare const steps: Record<string, StepResult>;
declare const needs: Record<string, NeedsResult>;
declare const vars: Record<string, string>;
declare const secrets: Record<string, string>;
/**
 * A value that arrived as JSON, so its shape is whatever the workflow put
 * there. Narrow it before use -- `String(matrix.os)`, or a typeof check.
 */
type ContextValue = string | number | boolean | null | ContextValue[] | { [key: string]: ContextValue };

/**
 * A reusable workflow declares an input's type, so a value here is a string, a
 * number or a boolean. A composite action's inputs are always strings.
 */
declare const inputs: Record<string, string | number | boolean>;
declare const strategy: StrategyContext;
declare const matrix: Record<string, ContextValue>;
