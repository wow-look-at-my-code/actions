// Scopes a check to the diff: a check nobody can turn green gets routed around.

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';

export type Event = {
	name: string;
	payload: unknown;
};

// Which lines of which files a change added or rewrote.
export type Touched = Map<string, Set<number>>;

export type Scope = {
	// The lines the event changed, or null when the base is unknown.
	touched: Touched | null;
	// What this run scoped to, or why it could not.
	note: string;
};

export type Git = (args: string[]) => string;

function field(value: unknown, ...path: string[]): string | null {
	let node: unknown = value;
	for (const key of path) {
		if (node === null || typeof node !== 'object') return null;
		node = (node as Record<string, unknown>)[key];
	}
	return typeof node === 'string' && node !== '' ? node : null;
}

// All zeros is git for "there was nothing here before".
function real(sha: string | null): string | null {
	return sha !== null && !/^0+$/.test(sha) ? sha : null;
}

// Names the commit this event's diff starts from. A pull request measures
// against the branch it merges into, a push against the tip it replaced, and a
// brand new branch against the default branch.
export function baseOf(event: Event): string | null {
	const {name, payload} = event;
	if (name === 'pull_request' || name === 'pull_request_target') {
		return real(field(payload, 'pull_request', 'base', 'sha'));
	}
	const before = real(field(payload, 'before'));
	if (before !== null) return before;
	const branch = field(payload, 'repository', 'default_branch');
	return branch === null ? null : `refs/heads/${branch}`;
}

// Lists the lines between the base and HEAD, by file. The fetch is for the
// depth-1 checkout, which does not carry the base commit.
export function changedLines(base: string, git: Git = runGit): Touched {
	let rev = base;
	if (base.startsWith('refs/')) {
		git(['fetch', '--no-tags', '--depth=1', 'origin', base]);
		rev = 'FETCH_HEAD';
	} else {
		try {
			git(['cat-file', '-e', `${base}^{commit}`]);
		} catch {
			git(['fetch', '--no-tags', '--depth=1', 'origin', base]);
		}
	}
	return parseHunks(git(['diff', '--unified=0', '--no-color', '--no-renames', '--diff-filter=ACMT', rev, 'HEAD']));
}

const FILE_RE = /^\+\+\+ (?:b\/)?(.+)$/;
// @@ -old,count +new,count @@ -- the "+" side names the lines that now exist.
const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// Reads a unified diff into the lines each file now has and did not before. A
// deletion adds no line, so it contributes nothing.
export function parseHunks(diff: string): Touched {
	const touched: Touched = new Map();
	let file = '';
	for (const line of diff.split('\n')) {
		const f = FILE_RE.exec(line);
		if (f !== null) {
			file = f[1] === '/dev/null' ? '' : f[1];
			continue;
		}
		const h = HUNK_RE.exec(line);
		if (h === null || file === '') continue;
		const start = Number(h[1]);
		const count = h[2] === undefined ? 1 : Number(h[2]);
		let lines = touched.get(file);
		if (lines === undefined) {
			lines = new Set();
			touched.set(file, lines);
		}
		for (let i = 0; i < count; i++) lines.add(start + i);
	}
	return touched;
}

// Resolves the scope for this run. This decides what to SKIP, so a failure
// widens the scope rather than narrowing it: skipping on an error is a check
// that passes for the wrong reason.
export function scopeOf(tool: string, event: Event, git: Git = runGit): Scope {
	const base = baseOf(event);
	if (base === null) {
		return {touched: null, note: `${tool}: the ${event.name} event names no base commit, so this run reads the whole tree`};
	}
	try {
		const touched = changedLines(base, git);
		const lines = [...touched.values()].reduce((n, set) => n + set.size, 0);
		return {touched, note: `${tool}: scoped to ${lines} line(s) across ${touched.size} file(s) changed since ${base}`};
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {touched: null, note: `${tool}: could not diff against ${base} (${why}), so this run reads the whole tree`};
	}
}

// Whether one finding's own line was changed.
export function touchedAt(touched: Touched, path: string, line: number): boolean {
	return touched.get(path)?.has(line) ?? false;
}

// Keeps the findings on a changed line, from "path:line: ..." text.
export function onTouchedLines<T extends object>(findings: T, touched: Touched): T {
	const out: Record<string, string[]> = {};
	for (const [rule, list] of Object.entries(findings) as [string, string[]][]) {
		out[rule] = list.filter((finding) => {
			const m = /^(.*?):(\d+):/.exec(finding);
			if (m === null) return true;
			return touchedAt(touched, m[1], Number(m[2]));
		});
	}
	return out as T;
}

// An unreadable payload leaves the base unknown, which widens the scope.
export function currentEvent(): Event {
	const name = process.env.GITHUB_EVENT_NAME ?? '';
	const path = process.env.GITHUB_EVENT_PATH;
	if (path === undefined || path === '') return {name, payload: null};
	try {
		return {name, payload: JSON.parse(readFileSync(path, 'utf-8'))};
	} catch {
		return {name, payload: null};
	}
}

function runGit(args: string[]): string {
	return execFileSync('git', args, {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']});
}
