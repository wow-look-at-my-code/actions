import assert from 'node:assert/strict';
import {test} from 'node:test';
import {baseOf, changedLines, onTouchedLines, parseHunks, scopeOf} from './changed';

const ZERO = '0000000000000000000000000000000000000000';

test('a pull request measures against the branch it merges into', () => {
	assert.equal(baseOf({name: 'pull_request', payload: {pull_request: {base: {sha: 'abc123'}}}}), 'abc123');
	assert.equal(baseOf({name: 'pull_request_target', payload: {pull_request: {base: {sha: 'abc123'}}}}), 'abc123');
});

test('a push measures against the tip it replaced', () => {
	assert.equal(baseOf({name: 'push', payload: {before: 'def456', repository: {default_branch: 'master'}}}), 'def456');
});

test("a new branch has no tip to replace, so it measures against the default branch", () => {
	assert.equal(baseOf({name: 'push', payload: {before: ZERO, repository: {default_branch: 'master'}}}), 'refs/heads/master');
});

test('an event that names neither leaves the base unknown', () => {
	assert.equal(baseOf({name: 'workflow_dispatch', payload: {}}), null);
	assert.equal(baseOf({name: 'push', payload: null}), null);
	assert.equal(baseOf({name: 'pull_request', payload: {pull_request: {}}}), null);
});

const DIFF = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -4,0 +5,2 @@ intro
+a new line
+and another
@@ -20 +21 @@
+a rewritten line
diff --git a/docs/gone.md b/docs/gone.md
--- a/docs/gone.md
+++ /dev/null
@@ -1,3 +0,0 @@
`;

test('a hunk names the lines the file now has, and a deletion names none', () => {
	const touched = parseHunks(DIFF);
	assert.deepEqual([...touched.keys()], ['README.md']);
	assert.deepEqual([...touched.get('README.md')!].sort((a, b) => a - b), [5, 6, 21]);
});

test('a hunk with no count covers exactly one line', () => {
	const touched = parseHunks('+++ b/a.md\n@@ -9 +9 @@\n+one\n');
	assert.deepEqual([...touched.get('a.md')!], [9]);
});

test('the diff names the lines, and an absent base commit is fetched first', () => {
	const calls: string[][] = [];
	const git = (args: string[]): string => {
		calls.push(args);
		if (args[0] === 'cat-file') throw new Error('not our ref');
		return args[0] === 'diff' ? DIFF : '';
	};
	assert.deepEqual([...changedLines('def456', git).keys()], ['README.md']);
	assert.deepEqual(calls[0], ['cat-file', '-e', 'def456^{commit}']);
	assert.deepEqual(calls[1], ['fetch', '--no-tags', '--depth=1', 'origin', 'def456']);
	assert.equal(calls[2][0], 'diff');
	assert.ok(calls[2].includes('--unified=0'), 'the diff must carry no context, or an untouched line reads as changed');
});

test('a base commit already in the checkout is not fetched again', () => {
	const calls: string[][] = [];
	const git = (args: string[]): string => {
		calls.push(args);
		return args[0] === 'diff' ? DIFF : '';
	};
	changedLines('def456', git);
	assert.deepEqual(
		calls.map((c) => c[0]),
		['cat-file', 'diff'],
	);
});

test('a finding on a changed line stays, and one on an untouched line goes', () => {
	const touched = new Map([['CLAUDE.md', new Set([5, 6])]]);
	const kept = onTouchedLines(
		{
			semicolons: ['CLAUDE.md:5: ";"', 'CLAUDE.md:400: ";"'],
			wrappedLines: ['CLAUDE.md:6: continues line 5', 'docs/other.md:2: continues line 1'],
		},
		touched,
	);
	assert.deepEqual(kept.semicolons, ['CLAUDE.md:5: ";"']);
	assert.deepEqual(kept.wrappedLines, ['CLAUDE.md:6: continues line 5']);
});

test('a finding with no line prefix is kept, because nothing places it', () => {
	const kept = onTouchedLines({hardLong: ['a finding with no location']}, new Map());
	assert.deepEqual(kept.hardLong, ['a finding with no location']);
});

test('a branch base is fetched and read back as FETCH_HEAD', () => {
	const calls: string[][] = [];
	const git = (args: string[]): string => {
		calls.push(args);
		return '';
	};
	changedLines('refs/heads/master', git);
	assert.deepEqual(calls[0], ['fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/master']);
	assert.equal(calls[1].at(-2), 'FETCH_HEAD');
});

test('a push that changed nothing scopes to nothing, which is not the same as unknown', () => {
	const scope = scopeOf({name: 'push', payload: {before: 'def456'}}, () => '');
	assert.equal(scope.touched?.size, 0);
});

test('a git failure widens the scope rather than narrowing it', () => {
	const git = (): string => {
		throw new Error('fatal: bad object');
	};
	const scope = scopeOf({name: 'push', payload: {before: 'def456'}}, git);
	assert.equal(scope.touched, null);
	assert.match(scope.note, /whole tree/);
});

test('an event with no base widens the scope too', () => {
	const scope = scopeOf({name: 'schedule', payload: {}}, () => '');
	assert.equal(scope.touched, null);
	assert.match(scope.note, /whole tree/);
});
