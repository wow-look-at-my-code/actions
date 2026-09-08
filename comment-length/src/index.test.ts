import assert from 'node:assert/strict';
import test from 'node:test';
import {Finding, keep, render, report} from './index';

const FINDINGS = JSON.stringify({
	path: 'a.go',
	findings: [
		{id: 'comments/length', line: 7, rule: 'the comment runs longer', detail: '// x'},
		{id: 'ste/count', line: 9, rule: 'a number in a comment', detail: '// three'},
	],
});

test('only the comment-length findings are read, so a shared report cannot widen the rule', () => {
	const got = report('/bin/slopfix', 'a.go', 'package a', () => FINDINGS);
	assert.deepEqual(got, [{path: 'a.go', line: 7, rule: 'the comment runs longer', detail: '// x'}]);
});

test('a clean file reports nothing rather than throwing on empty output', () => {
	assert.deepEqual(report('/bin/slopfix', 'a.go', 'package a', () => ''), []);
});

test('the path comes from the caller, never from the report', () => {
	const got = report('/bin/slopfix', 'sub/dir/b.go', 'package b', () => FINDINGS);
	assert.equal(got[0].path, 'sub/dir/b.go');
});

const AT7: Finding = {path: 'a.go', line: 7, rule: 'r', detail: 'd'};
const AT9: Finding = {path: 'a.go', line: 9, rule: 'r', detail: 'd'};

test('a finding on a changed line stays and one on an untouched line goes', () => {
	const touched = new Map([['a.go', new Set([7])]]);
	assert.deepEqual(keep([AT7, AT9], touched), [AT7]);
});

test('a finding in a file this push never touched goes', () => {
	const touched = new Map([['other.go', new Set([7])]]);
	assert.deepEqual(keep([AT7], touched), []);
});

// The scope is what decides what to SKIP, so losing it must widen the run.
test('an unknown scope keeps every finding rather than passing quietly', () => {
	assert.deepEqual(keep([AT7, AT9], null), [AT7, AT9]);
});

test('a finding renders as the path and line a writer can go to', () => {
	assert.equal(render(AT7), 'a.go:7: r');
});
