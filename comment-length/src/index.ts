// slopfix owns the rule. This decides which findings a push answers for.

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import * as core from '@actions/core';
import {Touched, currentEvent, scopeOf, touchedAt} from '../../_shared/changed/changed';

const TOOL = 'comment-length';

export type Finding = {
	path: string;
	line: number;
	rule: string;
	detail: string;
};

type Run = (args: string[], stdin: string) => string;

// slopfix reads the content on stdin and names the path separately, so a file
// is judged as itself rather than by whatever the walk happens to select.
export function report(slopfix: string, path: string, content: string, run: Run): Finding[] {
	const out = run([slopfix, 'report', '--path', path], content);
	if (out.trim() === '') return [];
	const parsed = JSON.parse(out) as {findings?: {id: string; line: number; rule: string; detail: string}[]};
	return (parsed.findings ?? [])
		.filter((f) => f.id.startsWith('comments/length'))
		.map((f) => ({path, line: f.line, rule: f.rule, detail: f.detail}));
}

// A finding is kept when the push touched the line the comment starts on. An
// unknown scope keeps everything, because skipping on an error is a check that
// passes for the wrong reason.
export function keep(findings: Finding[], touched: Touched | null): Finding[] {
	if (touched === null) return findings;
	return findings.filter((f) => touchedAt(touched, f.path, f.line));
}

export function render(f: Finding): string {
	return `${f.path}:${f.line}: ${f.rule}`;
}

function runSlopfix(args: string[], stdin: string): string {
	return execFileSync(args[0], args.slice(1), {encoding: 'utf-8', input: stdin, stdio: ['pipe', 'pipe', 'pipe']});
}

// With no scope to narrow by, slopfix walks the tree itself and its exit code
// is the answer. Reporting nothing here would be the silent pass the scope note
// promised not to be.
function wholeTree(slopfix: string): void {
	try {
		execFileSync(slopfix, ['comment-length', '.'], {encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe']});
	} catch (err) {
		const out = err instanceof Error && 'stdout' in err ? String(err.stdout) : '';
		for (const line of out.split('\n').filter((l) => l !== '')) core.error(line);
		core.setFailed(`${TOOL}: cut each comment back inside the code it documents`);
	}
}

export async function main(): Promise<void> {
	const slopfix = core.getInput('slopfix', {required: true});
	const scope = scopeOf(TOOL, currentEvent());
	core.info(scope.note);

	if (scope.touched === null) {
		wholeTree(slopfix);
		return;
	}

	const findings: Finding[] = [];
	for (const path of scope.touched.keys()) {
		let content: string;
		try {
			content = readFileSync(path, 'utf-8');
		} catch {
			// Deleted between the diff and now, so it carries no comment.
			continue;
		}
		findings.push(...report(slopfix, path, content, runSlopfix));
	}

	const kept = keep(findings, scope.touched);
	for (const f of kept) core.error(render(f), {file: f.path, startLine: f.line});
	if (kept.length > 0) {
		core.setFailed(`${TOOL}: cut each comment back inside the code it documents`);
	}
}
