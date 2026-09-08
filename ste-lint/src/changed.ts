// This action lints what a push changed, not what the repository contains.
//
// A whole-tree lint asks a repository to answer for prose it did not write in
// this change, and for prose it may not have written at all. A fork carries its
// upstream's documentation. An imported tree carries somebody else's. Neither
// belongs to the person whose commit turned the check red, and a check that
// nobody can turn green is a check people route around.
//
// So the scope is the diff. A file this push did not touch is out of scope even
// when it has findings, and the same file comes into scope the moment somebody
// edits it. The rule that reaches the author is the rule the author can obey.

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

type Git = (args: string[]) => string;

function field(value: unknown, ...path: string[]): string | null {
	let node: unknown = value;
	for (const key of path) {
		if (node === null || typeof node !== 'object') return null;
		node = (node as Record<string, unknown>)[key];
	}
	return typeof node === 'string' && node !== '' ? node : null;
}

// A commit of all zeros is git's way of saying "there was nothing here before":
// the first push of a branch, or a branch that was just created.
function real(sha: string | null): string | null {
	return sha !== null && !/^0+$/.test(sha) ? sha : null;
}

// Names the commit this event's diff starts from. A pull request measures
// against the branch it merges into. A push measures against the branch tip it
// replaced, and a brand new branch has no such tip, so it measures against the
// default branch instead.
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

// Lists the lines between the base and HEAD, by file.
//
// The unit is a line, not a file. A change that edits one sentence of a long
// document answers for that sentence. It does not inherit every finding the
// document already carried, which is what turns a check into a wall.
//
// `git diff` compares two trees and never needs a common ancestor, so a
// depth-1 checkout works once the base commit itself is present. That is what
// the fetch is for: actions/checkout takes one commit by default, and the base
// is not it.
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

// Reads a unified diff into the set of lines each file now has that it did not
// have before. A deletion adds no line, so it contributes nothing.
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

// Resolves the scope for this run. A failure here returns a null scope, and the
// caller then lints everything and says so: this decides what to SKIP, and a
// check that skips on an error is a check that passes for the wrong reason.
export function scopeOf(event: Event, git: Git = runGit): Scope {
	const base = baseOf(event);
	if (base === null) {
		return {touched: null, note: `ste-lint: the ${event.name} event names no base commit, so this run reads the whole tree`};
	}
	try {
		const touched = changedLines(base, git);
		const lines = [...touched.values()].reduce((n, set) => n + set.size, 0);
		return {touched, note: `ste-lint: scoped to ${lines} line(s) across ${touched.size} file(s) changed since ${base}`};
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {touched: null, note: `ste-lint: could not diff against ${base} (${why}), so this run reads the whole tree`};
	}
}

// Keeps the findings that sit on a changed line. A finding is reported as
// "path:line: ...", which is the line the writer must go and fix.
export function onTouchedLines<T extends object>(findings: T, touched: Touched): T {
	const out: Record<string, string[]> = {};
	for (const [rule, list] of Object.entries(findings) as [string, string[]][]) {
		out[rule] = list.filter((finding) => {
			const m = /^(.*?):(\d+):/.exec(finding);
			if (m === null) return true;
			return touched.get(m[1])?.has(Number(m[2])) ?? false;
		});
	}
	return out as T;
}

// Reads the event this run was started by. An unreadable payload is not an
// error: it leaves the base unknown, which widens the scope rather than
// narrowing it.
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
