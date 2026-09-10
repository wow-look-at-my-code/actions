import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionDirsFromPaths, classifyTag, parseTag, TagContext } from './classify';

function ctx(overrides: Partial<TagContext> = {}): TagContext {
	return {
		actionDirs: new Set(['widget', 'a/b', '.github/actions/setup-and-build']),
		branches: new Set(['master', 'feature-branch', 'claude/session-bdZri']),
		currentBranch: 'master',
		defaultBranch: 'master',
		...overrides,
	};
}

test('parseTag strips the ref prefix and peel suffix', () => {
	assert.deepEqual(parseTag('refs/tags/widget#1'), { tag: 'widget#1', name: 'widget', version: '1' });
	assert.deepEqual(parseTag('widget#latest'), { tag: 'widget#latest', name: 'widget', version: 'latest' });
	assert.deepEqual(parseTag('refs/tags/widget#7^{}'), { tag: 'widget#7', name: 'widget', version: '7' });
	assert.deepEqual(parseTag('refs/tags/a/b/c#2'), { tag: 'a/b/c#2', name: 'a/b/c', version: '2' });
});

test('parseTag splits at the last #, so branch names may contain #', () => {
	assert.deepEqual(parseTag('widget/br#anch#1'), { tag: 'widget/br#anch#1', name: 'widget/br#anch', version: '1' });
});

test('parseTag returns null for tags without #', () => {
	assert.equal(parseTag('refs/tags/milestone-tag'), null);
	assert.equal(parseTag('v1.0'), null);
});

test('actionDirsFromPaths keeps only directories carrying an action.yml', () => {
	const dirs = actionDirsFromPaths([
		'action.yml',
		'widget/action.yml',
		'a/b/action.yml',
		'a/b/other.yml',
		'.github/actions/setup-and-build/action.yml',
		'_shared/cache-xfer/lib.ts',
		'widget/index.ts',
	]);
	assert.deepEqual([...dirs].sort(), ['.github/actions/setup-and-build', 'a/b', 'widget']);
});

test('actionDirsFromPaths never adds the repo root', () => {
	const dirs = actionDirsFromPaths(['action.yml']);
	assert.equal(dirs.size, 0);
});

test('a release tag for a living action is kept', () => {
	const verdict = classifyTag('refs/tags/widget#latest', ctx());
	assert.deepEqual(verdict, { kind: 'keep', why: "action 'widget' exists on master" });
});

test('a release tag for a dead action is deleted', () => {
	const verdict = classifyTag('refs/tags/go-packages#latest', ctx());
	assert.deepEqual(verdict, { kind: 'delete', why: "no directory 'go-packages' exists on master" });
});

test('a branch tag for a dead action is deleted', () => {
	const verdict = classifyTag('refs/tags/go-packages/pi-signoff#1', ctx());
	assert.deepEqual(verdict, { kind: 'delete', why: "no directory 'go-packages/pi-signoff' exists on master" });
});

test('a nested path only matches when every segment up to the action is real', () => {
	const verdict = classifyTag('refs/tags/shared/cache-xfer#1', ctx());
	assert.equal(verdict.kind, 'delete');
});

test('a branch tag whose branch is gone is deleted', () => {
	const verdict = classifyTag('refs/tags/widget/dead-branch#1', ctx());
	assert.deepEqual(verdict, { kind: 'delete', why: "branch 'dead-branch' no longer exists" });
});

test('a branch tag whose branch exists is kept', () => {
	const verdict = classifyTag('refs/tags/widget/feature-branch#3', ctx());
	assert.deepEqual(verdict, { kind: 'keep', why: "branch 'feature-branch' exists" });
});

test('a branch tag for the current branch is kept even when the remote list lacks it', () => {
	const c = ctx({ branches: new Set<string>([]) });
	const verdict = classifyTag('refs/tags/widget/master#1', c);
	assert.deepEqual(verdict, { kind: 'keep', why: "branch 'master' is the current branch" });
});

test('branch names may contain slashes', () => {
	const verdict = classifyTag('refs/tags/widget/claude/session-bdZri#1', ctx());
	assert.deepEqual(verdict, { kind: 'keep', why: "branch 'claude/session-bdZri' exists" });
});

test('the deepest action root wins, and the branch is the rest', () => {
	const c = ctx({ actionDirs: new Set(['widget', 'widget/sub']) });
	assert.deepEqual(classifyTag('refs/tags/widget/sub/feature-branch#1', c), {
		kind: 'keep',
		why: "branch 'feature-branch' exists",
	});
	assert.deepEqual(classifyTag('refs/tags/widget/other#1', c), {
		kind: 'delete',
		why: "branch 'other' no longer exists",
	});
});

test('an internal action directory is a valid action root', () => {
	const verdict = classifyTag('refs/tags/.github/actions/setup-and-build/feature-branch#1', ctx());
	assert.deepEqual(verdict, { kind: 'keep', why: "branch 'feature-branch' exists" });
});

test('a garbage version is deleted even for a living action', () => {
	const verdict = classifyTag('refs/tags/widget#null', ctx());
	assert.deepEqual(verdict, { kind: 'delete', why: "version 'null' is neither a number nor latest" });
});

test('an empty version is garbage', () => {
	const verdict = classifyTag('refs/tags/widget#', ctx());
	assert.deepEqual(verdict, { kind: 'delete', why: "version '' is neither a number nor latest" });
});

test('numbered and latest versions are sane', () => {
	assert.equal(classifyTag('refs/tags/widget#0', ctx()).kind, 'keep');
	assert.equal(classifyTag('refs/tags/widget#12', ctx()).kind, 'keep');
	assert.equal(classifyTag('refs/tags/widget#latest', ctx()).kind, 'keep');
});

test('a tag without # is kept and never guessed at', () => {
	const verdict = classifyTag('refs/tags/release-snapshot', ctx());
	assert.deepEqual(verdict, { kind: 'keep', why: 'no #, not a release tag' });
});
