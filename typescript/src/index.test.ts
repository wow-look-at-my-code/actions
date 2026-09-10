import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

const execFileAsync = promisify(execFile);
const DIST = path.join(__dirname, '..', 'dist', 'index.js');

interface RunResult {
	/** Process stdout with the echoed script source removed. */
	stdout: string;
	/** Full process stdout, source echo included. */
	rawStdout: string;
	stderr: string;
	exitCode: number;
}

// The action opens the "Compiling script" group by echoing the (highlighted)
// script source. Strip just that echo from `stdout` so assertions about what
// actually executed aren't satisfied by the mere echo of the script text;
// `rawStdout` keeps it. The rest of the group (the type-check/transpile lines
// and any ::error:: diagnostics) stays -- tests assert on those.
const SOURCE_ECHO = /^::group::Compiling script\n[\s\S]*?(?=^Type-check passed\.$|^::error::)/m;

async function runAction(script: string, env: Record<string, string> = {}): Promise<RunResult> {
	try {
		const { stdout, stderr } = await execFileAsync('node', [DIST], {
			env: { ...process.env, INPUT_SCRIPT: script, ...env },
			timeout: 15000,
		});
		return { stdout: stdout.replace(SOURCE_ECHO, ''), rawStdout: stdout, stderr, exitCode: 0 };
	} catch (err: unknown) {
		// execFile rejects with an Error carrying the captured streams and the
		// exit code, which no Node type declares.
		const failure = err as { stdout?: string; stderr?: string; code?: number };
		const stdout: string = failure.stdout ?? '';
		return { stdout: stdout.replace(SOURCE_ECHO, ''), rawStdout: stdout, stderr: failure.stderr ?? '', exitCode: failure.code ?? 1 };
	}
}

// Parse the heredoc-style $GITHUB_OUTPUT file that @actions/core writes:
//   <name><<ghadelimiter_<uuid>\n<value>\nghadelimiter_<uuid>\n
function parseGithubOutput(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	const lines = raw.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(.+?)<<(ghadelimiter_\S+)$/);
		if (!m) continue;
		const [, key, delim] = m;
		const value: string[] = [];
		for (i++; i < lines.length && lines[i] !== delim; i++) value.push(lines[i]);
		out[key] = value.join('\n');
	}
	return out;
}

// Run the action with a real $GITHUB_OUTPUT file so the `result` output is observable.
async function runActionWithOutputs(
	script: string,
	env: Record<string, string> = {},
): Promise<RunResult & { outputs: Record<string, string> }> {
	const outFile = path.join(os.tmpdir(), `gh-output-${process.pid}-${Math.random().toString(36).slice(2)}`);
	fs.writeFileSync(outFile, '');
	try {
		const res = await runAction(script, { ...env, GITHUB_OUTPUT: outFile });
		return { ...res, outputs: parseGithubOutput(fs.readFileSync(outFile, 'utf-8')) };
	} finally {
		fs.rmSync(outFile, { force: true });
	}
}

describe('typescript action', () => {
	it('executes a basic script', async () => {
		const { stdout, exitCode } = await runAction('core.info("hello world")');
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('hello world'));
	});

	it('echoes the ANSI-highlighted script source in the single compile group', async () => {
		const { rawStdout, exitCode } = await runAction('const n = 1; // note');
		assert.equal(exitCode, 0);
		const echo = rawStdout.match(SOURCE_ECHO)?.[0];
		assert.ok(echo, `source echo missing in:\n${rawStdout}`);
		assert.ok(echo.includes('\x1b[38;2;255;123;114mconst\x1b[39m'), `keyword not highlighted in:\n${JSON.stringify(echo)}`);
		assert.ok(echo.includes('\x1b[38;2;139;148;158m// note\x1b[39m'), `comment not highlighted in:\n${JSON.stringify(echo)}`);
		// Source echo, type-check and transpile share one group, in that order,
		// and the split-out groups they replaced are gone for good.
		assert.ok(
			rawStdout.indexOf('::group::Compiling script') < rawStdout.indexOf('Type-check passed.')
				&& rawStdout.indexOf('Type-check passed.') < rawStdout.indexOf('Transpiled output:')
				&& rawStdout.indexOf('Transpiled output:') < rawStdout.indexOf('::endgroup::'),
			rawStdout,
		);
		assert.equal(rawStdout.match(/^::group::/gm)?.length, 2, `expected exactly 2 log groups in:\n${rawStdout}`);
		for (const gone of ['::group::Script source', '::group::Type-checking', '::group::Transpiling']) {
			assert.ok(!rawStdout.includes(gone), `${gone} should no longer exist:\n${rawStdout}`);
		}
	});

	it('does not know DOM types by default', async () => {
		const { stdout, exitCode } = await runAction('const el: Element | null = null; core.info(String(el));');
		assert.equal(exitCode, 1);
		assert.ok(stdout.includes("Cannot find name 'Element'"), stdout);
	});

	it('type-checks against the DOM library when dom is true', async () => {
		const { stdout, exitCode } = await runAction(
			'const el: Element | null = null; core.info("dom-ok:" + String(el));',
			{ INPUT_DOM: 'true' },
		);
		assert.equal(exitCode, 0, stdout);
		assert.ok(stdout.includes('dom-ok:null'), stdout);
	});

	it('keeps Node globals working with dom enabled', async () => {
		// lib.dom redeclares names @types/node also declares -- setTimeout,
		// fetch, URL. A conflict here would break every ordinary script that
		// turns the input on.
		const { stdout, exitCode } = await runAction(
			`const t = setTimeout(() => {}, 1); clearTimeout(t);
			const u = new URL("https://example.com/x"); core.info("both-ok:" + u.pathname + ":" + process.pid.toString().length);`,
			{ INPUT_DOM: 'true' },
		);
		assert.equal(exitCode, 0, stdout);
		assert.ok(stdout.includes('both-ok:/x:'), stdout);
	});

	it('rejects a dom input that is neither true nor false', async () => {
		const { stdout, stderr, exitCode } = await runAction('core.info("x")', { INPUT_DOM: 'yes' });
		assert.equal(exitCode, 1);
		assert.ok((stdout + stderr).includes("Input 'dom' must be 'true' or 'false'"), stdout + stderr);
	});

	it('supports top-level await', async () => {
		const { stdout, exitCode } = await runAction(
			'const x = await Promise.resolve(42); core.info("value:" + x)'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('value:42'));
	});

	it('supports top-level await with async operations', async () => {
		const { stdout, exitCode } = await runAction(`
			const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
			await delay(10);
			core.info("after-await");
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('after-await'));
	});

	it('runs top-level await interleaved with statements (no IIFE wrapper needed)', async () => {
		// The action's promise: write `await` at the top level alongside ordinary
		// statements and control flow — no `(async () => { ... })()` ceremony.
		// As a plain CommonJS module this would need an IIFE to await; here the
		// script is the body of the action's async function, so it just runs.
		const { stdout, exitCode } = await runAction(`
			core.info("start");
			const first = await Promise.resolve(10);
			let total = first;
			for (const n of [20, 30]) {
				total += await Promise.resolve(n);
			}
			core.info("total:" + total);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('start'));
		assert.ok(stdout.includes('total:60'));
	});

	it('supports a bare top-level return (TS1108 regression)', async () => {
		// A top-level `return` must type-check and run — it is legal inside the
		// async-function body the script is wrapped in. Before the fix this
		// failed type-check with "TS1108: A 'return' statement can only be used
		// within a function body."
		const { stdout, exitCode } = await runAction(`
			const skip = false;
			if (skip) return;
			core.info("did-not-skip");
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('did-not-skip'));
	});

	it('exposes a top-level return value as the result output', async () => {
		const { outputs, exitCode } = await runActionWithOutputs(`
			const sum = 1 + 2;
			core.info("computed");
			return { sum, label: "ok" };
		`);
		assert.equal(exitCode, 0);
		assert.equal(outputs.result, '{"sum":3,"label":"ok"}');
	});

	it('combines top-level await and return into the result output', async () => {
		const { outputs, exitCode } = await runActionWithOutputs(
			'const v = await Promise.resolve(7); return v * 6;'
		);
		assert.equal(exitCode, 0);
		assert.equal(outputs.result, '42');
	});

	it('supports dynamic import() with await', async () => {
		const { stdout, exitCode } = await runAction(`
			const core2 = await import("@actions/core");
			core2.info("dynamic:imported");
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('dynamic:imported'));
	});

	it('supports require of node built-in modules', async () => {
		const { stdout, exitCode } = await runAction(`
			const nodePath = require("path");
			const joined = await Promise.resolve(nodePath.join("a", "b"));
			core.info("path:" + joined);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('path:a/b') || stdout.includes('path:a\\b'));
	});

	// Bundled here rather than resolved from the caller's workspace, so a guard
	// can read YAML on a Windows runner, which carries no yq.
	it('supports require of the bundled yaml module', async () => {
		const { stdout, exitCode } = await runAction(`
			const yaml = require("yaml");
			const doc = yaml.parse("on:\\n  push:\\n    branches: ['**']\\n");
			core.info("branches:" + JSON.stringify(doc["on"].push.branches));
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('branches:["**"]'), stdout);
	});

	it('names a module it cannot resolve instead of overflowing the stack', async () => {
		const { stdout, exitCode } = await runAction(`
			try {
				require("no-such-module-anywhere");
				core.info("resolved:unexpected");
			} catch (e) {
				core.info("threw:" + (e instanceof Error ? e.message : String(e)));
			}
		`);
		assert.equal(exitCode, 0);
		assert.ok(!stdout.includes('Maximum call stack'), stdout);
		assert.ok(stdout.includes('no-such-module-anywhere'), stdout);
	});

	it('supports multiple awaits', async () => {
		const { stdout, exitCode } = await runAction(`
			const a = await Promise.resolve(1);
			const b = await Promise.resolve(2);
			const c = await Promise.resolve(a + b);
			core.info("sum:" + c);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('sum:3'));
	});

	it('propagates errors from awaited promises', async () => {
		const { stdout, exitCode } = await runAction(
			'await Promise.reject(new Error("boom"))'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('boom'));
	});

	it('fails on type errors', async () => {
		const { stdout, exitCode } = await runAction(
			'const x: number = "not a number"'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('TypeScript validation failed'));
	});

	it('accepts a comparison against an interpolated input, which reaches tsc as a literal (TS2367)', async () => {
		// What the action receives once GitHub has evaluated `'${{ inputs.assert }}'`
		// in a caller's script. The comparison is meaningful across runs; tsc sees
		// only this run's value and would call it always-false.
		const { stdout, exitCode } = await runAction(
			"const assert = 'false';\nif (assert === 'true') core.info('asserted');\ncore.info('ran');"
		);
		assert.equal(exitCode, 0, stdout);
		assert.ok(stdout.includes('Type-check passed.'), stdout);
		assert.ok(stdout.includes('ran'), stdout);
		assert.ok(!stdout.includes('asserted'), `the false branch must not run:\n${stdout}`);
	});

	it('fails on two consecutive `//` comment lines, but lets the step run to completion first', async () => {
		const { stdout, exitCode } = await runAction(
			'core.info("line one");\n// first\n// second\ncore.info("ran");'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('script:2:1:'), `expected the block reported at line 2, got:\n${stdout}`);
		assert.ok(stdout.includes('consecutive `//` comment lines (2-3)'), stdout);
		// The count alone reads as a threshold: a two-line block reported as "2
		// consecutive" invites shortening rather than collapsing, so the message
		// must also state the real limit.
		assert.ok(
			stdout.includes('The limit is ONE'),
			`the message must name the limit, not just the count:\n${stdout}`
		);
		assert.ok(stdout.includes('Type-check passed.'), `type-check must still run:\n${stdout}`);
		assert.ok(stdout.includes('ran'), `script must still execute:\n${stdout}`);
		assert.ok(stdout.includes('Comment check failed'), stdout);
		// the deferred failure message comes after the step actually ran
		assert.ok(stdout.indexOf('ran') < stdout.indexOf('Comment check failed'), stdout);
	});

	it('still fails immediately on a type error, even alongside a comment-block violation', async () => {
		const { stdout, exitCode } = await runAction(
			'// first\n// second\nconst x: number = "not a number";\ncore.info("ran");'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('TypeScript validation failed'), stdout);
		assert.ok(!stdout.includes('ran'), `a type error must still block execution:\n${stdout}`);
	});

	it('exempts a file input from the comment check', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-action-test-'));
		fs.writeFileSync(
			path.join(dir, 'script.ts'),
			['// a checked-in script may explain itself', '// across as many lines as it needs', 'core.info("from-file");'].join('\n')
		);
		try {
			const { exitCode, stdout } = await runAction('', { INPUT_FILE: 'script.ts', GITHUB_WORKSPACE: dir });
			assert.equal(exitCode, 0, stdout);
			assert.ok(stdout.includes('from-file'));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('accepts single comment lines and trailing comments', async () => {
		const { stdout, exitCode } = await runAction(
			'// a lone comment\nconst a = 1; // trailing\nconst b = 2; // trailing\ncore.info("sum:" + (a + b));'
		);
		assert.equal(exitCode, 0, stdout);
		assert.ok(stdout.includes('sum:3'));
	});

	it('maps type-error line numbers back to the user script', async () => {
		// The wrapper adds lines before the user code; diagnostics must still
		// point at the original `script:` line. The error is on line 2 here.
		const { stdout, exitCode } = await runAction(
			'core.info("line one");\nconst x: number = "nope";'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('script:2:'), `expected an error on line 2, got:\n${stdout}`);
	});

	it('supports top-level ESM import of @actions modules (same instance as the global)', async () => {
		// Top-level `import` used to be rejected (TS1232) when the whole script
		// was an async-function body. Imports are now hoisted to module scope —
		// and `@actions/*` imports resolve to the action's own instances.
		const { stdout, exitCode } = await runAction(
			'import * as c from "@actions/core";\nc.info("esm:" + (c.info === core.info));'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('esm:true'));
	});

	it('supports a top-level export alone', async () => {
		const { outputs, exitCode } = await runActionWithOutputs('export const VERSION = "1.0.0";');
		assert.equal(exitCode, 0);
		assert.ok(!('result' in outputs), `expected no result output, got: ${JSON.stringify(outputs)}`);
	});

	it('combines a top-level import with a top-level return into the result output', async () => {
		// A real ES module cannot contain a top-level `return`; an async function
		// body cannot contain a top-level `import`. Both must work at once.
		const expected = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;
		const { outputs, exitCode } = await runActionWithOutputs(`
			import { readFile } from "node:fs/promises";
			const pkg = JSON.parse(await readFile("package.json", "utf8"));
			return pkg.version;
		`);
		assert.equal(exitCode, 0);
		assert.equal(outputs.result, JSON.stringify(expected));
	});

	it('combines top-level import, injected globals, top-level await, and fetch typing', async () => {
		const { stdout, exitCode } = await runAction(
			`
			import { setTimeout as sleep } from "node:timers/promises";
			core.info(\`workspace = \${path.join(env.GITHUB_WORKSPACE ?? ".", "package.json")}\`);
			await sleep(10);
			const f: typeof fetch = fetch;
			core.info("fetch:" + typeof f);
			`,
			{ GITHUB_WORKSPACE: '/tmp/ws' }
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('workspace = /tmp/ws/package.json'));
		assert.ok(stdout.includes('fetch:function'));
	});

	it('supports a default import (esModuleInterop)', async () => {
		const { stdout, exitCode } = await runAction(
			'import assert2 from "node:assert/strict";\nassert2.equal(1 + 1, 2);\ncore.info("assert-ok");'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('assert-ok'));
	});

	it('handles the webhook-runner e2e shape: node: imports + globals + late functions + TLA', async () => {
		const { stdout, exitCode } = await runAction(`
			import { createServer } from "node:net";
			import { createHmac } from "node:crypto";
			import assert from "node:assert/strict";

			const BINARY = path.join("build", "webhook-runner");
			function freePort(): Promise<number> {
				return new Promise((resolve) => {
					const srv = createServer();
					srv.listen(0, "127.0.0.1", () => {
						const port = (srv.address() as { port: number }).port;
						srv.close(() => resolve(port));
					});
				});
			}
			const sig = createHmac("sha256", "k").update("payload").digest("hex");
			assert.equal(typeof child_process.execSync, "function");
			const port = await freePort();
			core.info("sig:" + sig.length + " port:" + port + " bin:" + BINARY);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('sig:64'));
		assert.ok(/port:\d+/.test(stdout));
	});

	it('still accepts a literal export {} marker', async () => {
		const { stdout, exitCode } = await runAction('export {};\ncore.info("legacy-marker");');
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('legacy-marker'));
	});

	it('supports top-level await in an exported const initializer', async () => {
		const { outputs, exitCode, stdout } = await runActionWithOutputs(
			'export const value = await Promise.resolve(5);\ncore.info("v:" + value);\nreturn value;'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('v:5'));
		assert.equal(outputs.result, '5');
	});

	it('maps type-error line numbers in scripts with hoisted imports', async () => {
		const { stdout, exitCode } = await runAction(
			'import * as fsp from "node:fs/promises";\ncore.info("ok:" + typeof fsp.readFile);\nconst n: number = "bad";'
		);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('script:3:'), `expected an error on line 3, got:\n${stdout}`);
	});

	it('elides type-only imports (no runtime require)', async () => {
		const { stdout, exitCode } = await runAction(
			'import type { Context } from "@actions/github/lib/context";\nconst c: Context | null = null;\ncore.info("type-ok:" + (c === null));'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('type-ok:true'));
	});

	it('supports top-level ESM import of @actions/github (context + getOctokit)', async () => {
		// The bundled stub must expose the module's real surface, not just the
		// Context class — `getOctokit` and `context` have to type-check AND
		// resolve to the action's own module instance at runtime.
		const { stdout, exitCode } = await runAction(
			[
				'import { getOctokit } from "@actions/github";',
				'import * as gh from "@actions/github";',
				'const oct = getOctokit("fake-token");',
				'core.info("gh:" + typeof oct.rest + ":" + typeof gh.context.eventName + ":" + (gh.getOctokit === getOctokit));',
			].join('\n'),
			{ GITHUB_EVENT_NAME: 'push' }
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('gh:object:string:true'));
	});

	it('treats a file input with a shebang identically to inline (import + await + return)', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-action-test-'));
		fs.writeFileSync(
			path.join(dir, 'script.ts'),
			[
				'#!/usr/bin/env -S npx tsx',
				'import { setTimeout as sleep } from "node:timers/promises";',
				'await sleep(5);',
				'core.info("from-file");',
				'return 7;',
			].join('\n')
		);
		try {
			const { outputs, exitCode, stdout } = await runActionWithOutputs('', {
				INPUT_FILE: 'script.ts',
				GITHUB_WORKSPACE: dir,
			});
			assert.equal(exitCode, 0);
			assert.ok(stdout.includes('from-file'));
			assert.equal(outputs.result, '7');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('provides workflow contexts', async () => {
		const { stdout, exitCode } = await runAction(
			'core.info("actor:" + github.actor)',
			{ GITHUB_ACTOR: 'testuser' }
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('actor:testuser'));
	});

	it('supports require of @actions modules', async () => {
		const { stdout, exitCode } = await runAction(`
			const c = require("@actions/core");
			const val = await Promise.resolve("required");
			c.info("req:" + val);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('req:required'));
	});

	it('provides a pre-authenticated octokit from the github-token input', async () => {
		const { stdout, exitCode } = await runAction(
			'core.info("octokit-rest:" + typeof octokit.rest)',
			{ 'INPUT_GITHUB-TOKEN': 'fake-token-for-test' }
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('octokit-rest:object'));
	});

	it('authenticates the injected octokit from the github-token input, not process.env.GITHUB_TOKEN (regression)', async () => {
		// Regression for "Error: Parameter token or opts.auth is required": the
		// runner does NOT expose GITHUB_TOKEN to the action process, so the
		// pre-authenticated octokit must take its token from the `github-token`
		// input (which defaults to ${{ github.token }}), never from process.env.
		// Here the token arrives ONLY via the input while GITHUB_TOKEN is empty in
		// the env; accessing octokit.rest must still succeed. Before the fix the
		// proxy read process.env.GITHUB_TOKEN and getOctokit('') threw on first use.
		const { stdout, exitCode } = await runAction(
			'core.info("octokit-rest:" + typeof octokit.rest)',
			{ 'INPUT_GITHUB-TOKEN': 'fake-token-from-input', GITHUB_TOKEN: '' }
		);
		assert.equal(exitCode, 0, `expected octokit.rest to be reachable, got:\n${stdout}`);
		assert.ok(stdout.includes('octokit-rest:object'));
	});

	it('octokit(token) emits deprecation warning and still works', async () => {
		const { stdout, exitCode } = await runAction(
			'const c = octokit("fake"); core.info("type:" + typeof c.rest)'
		);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('type:object'));
		assert.ok(stdout.toLowerCase().includes('deprecated'));
	});
});

describe('$ command runner', () => {
	it('resolves to a ProcessOutput with stdout, stderr, and exitCode', async () => {
		const { stdout, exitCode } = await runAction(`
			const arg = "hello world";
			const r = await $\`echo \${arg}\`;
			core.info("stdout=" + JSON.stringify(r.stdout));
			core.info("stderr=" + JSON.stringify(r.stderr));
			core.info("exitCode=" + r.exitCode);
		`);
		assert.equal(exitCode, 0);
		// echo appends a trailing newline; stdout is the raw, untrimmed stream.
		assert.ok(stdout.includes('stdout="hello world\\n"'), stdout);
		assert.ok(stdout.includes('stderr=""'));
		assert.ok(stdout.includes('exitCode=0'));
	});

	it('toString() trims a single trailing newline while stdout stays raw', async () => {
		const { stdout, exitCode } = await runAction(`
			const arg = "trim-me";
			const r = await $\`echo \${arg}\`;
			core.info("toString=[" + r.toString() + "]");
			core.info("raw=" + JSON.stringify(r.stdout));
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('toString=[trim-me]'), stdout);
		assert.ok(stdout.includes('raw="trim-me\\n"'), stdout);
	});

	it('string-coerces to trimmed stdout inside a template literal', async () => {
		const { stdout, exitCode } = await runAction(`
			const arg = "abc";
			core.info(\`coerced=\${await $\`echo \${arg}\`}\`);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('coerced=abc'), stdout);
	});

	it('captures stdout via destructuring (the headline one-liner)', async () => {
		const { stdout, exitCode } = await runAction(`
			const { stdout: out } = await $\`echo \${"captured"}\`;
			core.info("cap=" + out.trim());
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('cap=captured'), stdout);
	});

	it('stdout.json() parses the captured JSON (trailing newline tolerated)', async () => {
		const { stdout, exitCode } = await runAction(`
			const payload = JSON.stringify({ a: 1, b: ["x", "y"] });
			const code = "process.stdout.write(process.argv[1])";
			const r = await $\`node -e \${code} \${payload}\`;
			const data = r.stdout.json() as { a: number; b: string[] };
			core.info("json=" + data.a + ":" + data.b.join(","));
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('json=1:x,y'), stdout);
	});

	it('stdout.json() accepts a type parameter', async () => {
		const { stdout, exitCode } = await runAction(`
			const payload = JSON.stringify({ version: "1.2.3", count: 5 });
			const code = "process.stdout.write(process.argv[1])";
			const r = await $\`node -e \${code} \${payload}\`;
			const data = r.stdout.json<{ version: string; count: number }>();
			core.info("typed=" + data.version + "/" + (data.count + 1));
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('typed=1.2.3/6'), stdout);
	});

	it('stderr.json() parses the captured stderr too', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stderr.write(JSON.stringify({ err: true }))";
			const r = await $\`node -e \${code}\`;
			core.info("stderr-json=" + r.stderr.json<{ err: string }>().err);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('stderr-json=true'), stdout);
	});

	it('a stream still behaves as a string (methods, coercion, JSON.stringify)', async () => {
		// The .json() helper rides on a boxed String; ordinary string usage must
		// keep working. (Strict === against a literal is the documented exception.)
		const { stdout, exitCode } = await runAction(`
			const { stdout: out } = await $\`echo \${"hello world"}\`;
			core.info("trim=" + out.trim());
			core.info("split=" + out.trim().split(" ").length);
			core.info("includes=" + out.includes("world"));
			core.info("concat=" + ("[" + out.trim() + "]"));
			core.info("stringify=" + JSON.stringify(out));
			const asString: string = out;            // assignable to string
			core.info("len=" + asString.length);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('trim=hello world'), stdout);
		assert.ok(stdout.includes('split=2'), stdout);
		assert.ok(stdout.includes('includes=true'), stdout);
		assert.ok(stdout.includes('concat=[hello world]'), stdout);
		assert.ok(stdout.includes('stringify="hello world\\n"'), stdout);
	});

	it('builder.json() is a paren-free shortcut (no `(await ...)` needed)', async () => {
		const { stdout, exitCode } = await runAction(`
			const payload = JSON.stringify({ ok: true, n: 41 });
			const code = "process.stdout.write(process.argv[1])";
			const data = await $\`node -e \${code} \${payload}\`.json<{ ok: boolean; n: number }>();
			core.info("paren-free=" + data.ok + ":" + (data.n + 1));
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('paren-free=true:42'), stdout);
	});

	it('builder.json() accepts a type parameter', async () => {
		const { stdout, exitCode } = await runAction(`
			const payload = JSON.stringify({ version: "9.9.9" });
			const code = "process.stdout.write(process.argv[1])";
			const data = await $\`node -e \${code} \${payload}\`.json<{ version: string }>();
			core.info("typed-shortcut=" + data.version);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('typed-shortcut=9.9.9'), stdout);
	});

	it('builder.text() resolves to trimmed stdout paren-free', async () => {
		const { stdout, exitCode } = await runAction(`
			const sha = await $\`echo \${"deadbeef"}\`.text();
			core.info("text=[" + sha + "]");
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('text=[deadbeef]'), stdout);
	});

	it('builder.json() composes with modifiers chained before it', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write(JSON.stringify({ v: process.env.MYVAR }))";
			const data = await $\`node -e \${code}\`.env({ MYVAR: "via-env" }).json<{ v: string }>();
			core.info("composed=" + data.v);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('composed=via-env'), stdout);
	});

	it('await $`...`.stdout.json() works directly — no `(await ...)` wrapper', async () => {
		const { stdout, exitCode } = await runAction(`
			const payload = JSON.stringify({ ok: true, n: 7 });
			const code = "process.stdout.write(process.argv[1])";
			const data = await $\`node -e \${code} \${payload}\`.stdout.json<{ ok: boolean; n: number }>();
			core.info("lazy-stdout-json=" + data.ok + ":" + data.n);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('lazy-stdout-json=true:7'), stdout);
	});

	it('await $`...`.stderr.json() works directly too', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stderr.write(JSON.stringify({ warn: 3 }))";
			const data = await $\`node -e \${code}\`.stderr.json<{ warn: number }>();
			core.info("lazy-stderr-json=" + data.warn);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('lazy-stderr-json=3'), stdout);
	});

	it('await $`...`.stdout resolves to the raw stream (untrimmed, still .json()-able)', async () => {
		const { stdout, exitCode } = await runAction(`
			const out = await $\`echo \${"raw-line"}\`.stdout;
			core.info("raw=" + JSON.stringify(out));   // keeps the trailing newline
			core.info("trimmed=" + out.trim());
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('raw="raw-line\\n"'), stdout);
		assert.ok(stdout.includes('trimmed=raw-line'), stdout);
	});

	it('await $`...`.stdout.text() trims; .stdout.json() composes with modifiers', async () => {
		const { stdout, exitCode } = await runAction(`
			const sha = await $\`echo \${"v2"}\`.stdout.text();
			core.info("lazy-text=[" + sha + "]");
			const code = "process.stdout.write(JSON.stringify({ home: process.env.HOMEVAR }))";
			const data = await $\`node -e \${code}\`.env({ HOMEVAR: "set" }).stdout.json<{ home: string }>();
			core.info("lazy-composed=" + data.home);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('lazy-text=[v2]'), stdout);
		assert.ok(stdout.includes('lazy-composed=set'), stdout);
	});

	it('throws on a non-zero exit by default', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.exit(3)";
			await $\`node -e \${code}\`;
			core.info("should-not-reach");
		`);
		assert.notEqual(exitCode, 0);
		assert.ok(stdout.includes('exit code 3'), stdout);
		assert.ok(!stdout.includes('should-not-reach'), stdout);
	});

	it('the thrown error carries captured stdout/stderr/exitCode', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write('O');process.stderr.write('E');process.exit(1)";
			try {
				await $\`node -e \${code}\`;
				core.info("no-throw");
			} catch (e: any) {
				core.info("caught=" + e.exitCode + "|" + e.stdout + "|" + e.stderr);
			}
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('caught=1|O|E'), stdout);
	});

	it('.nothrow() resolves on a non-zero exit so the caller reads exitCode', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.exit(7)";
			const r = await $\`node -e \${code}\`.nothrow();
			core.info("nothrow-code=" + r.exitCode);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('nothrow-code=7'), stdout);
	});

	it('.env() merges over the process env (override applied, PATH preserved)', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write((process.env.MYVAR || '?') + ':' + (process.env.PATH ? 'haspath' : 'nopath'))";
			const r = await $\`node -e \${code}\`.env({ MYVAR: "from-env" });
			core.info("env=" + r.stdout);
		`);
		assert.equal(exitCode, 0);
		// from-env proves the override; haspath proves it merged rather than replaced.
		assert.ok(stdout.includes('env=from-env:haspath'), stdout);
	});

	it('passes each interpolated value as exactly one argument (no shell split)', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write(process.argv.length + '|' + process.argv[1])";
			const arg = "a b c";
			const r = await $\`node -e \${code} \${arg}\`;
			core.info("argv=" + r.stdout);
		`);
		assert.equal(exitCode, 0);
		// 2 == [node, "a b c"]; a shell-split would yield 4 ([node, a, b, c]).
		assert.ok(stdout.includes('argv=2|a b c'), stdout);
	});

	it('expands an array interpolation to multiple arguments', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write(process.argv.length + ':' + process.argv.slice(1).join(','))";
			const flags = ["x", "y", "z"];
			const r = await $\`node -e \${code} \${flags}\`;
			core.info("arr=" + r.stdout);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('arr=4:x,y,z'), stdout);
	});

	it('skips a falsy interpolation (conditional flag)', async () => {
		const { stdout, exitCode } = await runAction(`
			const code = "process.stdout.write(String(process.argv.length))";
			const verbose = false;
			const r = await $\`node -e \${code} \${verbose && "-v"}\`;
			core.info("falsy=" + r.stdout);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('falsy=1'), stdout);
	});

	it('.input() pipes data to stdin', async () => {
		const { stdout, exitCode } = await runAction(`
			const r = await $\`cat\`.input("piped-data");
			core.info("input=" + r.stdout);
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('input=piped-data'), stdout);
	});

	it('.cwd() sets the working directory', async () => {
		const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ts-dollar-cwd-')));
		try {
			const { stdout, exitCode } = await runAction(`
				const code = "process.stdout.write(process.cwd())";
				const r = await $\`node -e \${code}\`.cwd(${JSON.stringify(dir)});
				core.info("cwd=" + r.stdout);
			`);
			assert.equal(exitCode, 0);
			assert.ok(stdout.includes('cwd=' + dir), stdout);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it('.silent() captures output without streaming it to the log', async () => {
		const { stdout, exitCode } = await runAction(`
			const arg = "shh";
			const r = await $\`echo \${arg}\`.silent();
			core.info("silent-captured=" + r.toString());
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('silent-captured=shh'), stdout);
		// Silent suppresses both the "[command]" echo and the streamed stdout, so
		// "shh" appears exactly once — from the core.info line above.
		assert.equal(stdout.split('shh').length - 1, 1, `expected 'shh' exactly once, got:\n${stdout}`);
	});

	it('chains modifiers, preserving earlier options (input survives a later .silent())', async () => {
		const { stdout, exitCode } = await runAction(`
			const r = await $\`cat\`.input("chained").silent();
			core.info("chain=" + r.toString());
		`);
		assert.equal(exitCode, 0);
		assert.ok(stdout.includes('chain=chained'), stdout);
	});
});
