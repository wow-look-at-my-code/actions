import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './cleanup';

function sh(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

interface Scenario {
	origin: string;
	repo: string;
	dir: string;
}

// One live action (widget), one surviving branch, one deleted branch, and a
// tag for every classification outcome. Everything is local: a bare origin on
// disk, no token, no network.
function makeScenario(): Scenario {
	const dir = mkdtempSync(join(tmpdir(), 'tag-cleanup-'));
	const origin = join(dir, 'origin.git');
	const repo = join(dir, 'repo');

	sh(dir, 'init', '--quiet', '--bare', origin);
	sh(origin, 'symbolic-ref', 'HEAD', 'refs/heads/master');

	mkdirSync(join(repo, 'widget'), { recursive: true });
	writeFileSync(join(repo, 'widget', 'action.yml'), 'runs:\n  using: composite\n');
	sh(repo, 'init', '--quiet');
	sh(repo, 'config', 'user.email', 't@example.com');
	sh(repo, 'config', 'user.name', 'test');
	sh(repo, 'checkout', '--quiet', '-b', 'master');
	sh(repo, 'add', '-A');
	sh(repo, 'commit', '--quiet', '-m', 'source');
	sh(repo, 'remote', 'add', 'origin', origin);
	sh(repo, 'push', '--quiet', 'origin', 'master');

	// A branch that survives the sweep
	sh(repo, 'checkout', '--quiet', '-b', 'feature-branch');
	writeFileSync(join(repo, 'widget', 'extra.txt'), 'x');
	sh(repo, 'add', '-A');
	sh(repo, 'commit', '--quiet', '-m', 'branch work');
	sh(repo, 'push', '--quiet', 'origin', 'feature-branch');
	sh(repo, 'checkout', '--quiet', 'master');

	const tags = [
		'widget#1',
		'widget#latest',
		'widget#null',
		'dead-action#latest',
		'widget/dead-branch#1',
		'widget/feature-branch#1',
		'widget/master#1',
		'plainref',
	];
	for (const tag of tags) {
		sh(repo, 'tag', tag);
	}
	sh(repo, 'push', '--quiet', 'origin', '--tags');

	return { origin, repo, dir };
}

function remoteTags(origin: string): Set<string> {
	const out = sh(origin, 'for-each-ref', '--format=%(refname:short)', 'refs/tags');
	return new Set(out.split('\n').filter((line) => line.length > 0));
}

function readOutputValue(outputFile: string, name: string): string {
	const content = readFileSync(outputFile, 'utf8');
	const lines = content.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith(`${name}<<`)) {
			return lines[i + 1];
		}
	}
	throw new Error(`output '${name}' not found in ${outputFile}`);
}

async function runCleanup(scenario: Scenario, dryRun: boolean): Promise<string> {
	const outputFile = join(scenario.dir, 'output.txt');
	// @actions/core appends to GITHUB_OUTPUT and requires the file to exist
	writeFileSync(outputFile, '');
	const previous = process.env.GITHUB_OUTPUT;
	process.env.GITHUB_OUTPUT = outputFile;
	try {
		await run({ cwd: scenario.repo, dryRun, currentBranch: 'master' });
	} finally {
		if (previous === undefined) delete process.env.GITHUB_OUTPUT;
		else process.env.GITHUB_OUTPUT = previous;
	}
	return outputFile;
}

test('sweeps tags whose action, branch, or version is gone', async () => {
	const scenario = makeScenario();
	try {
		const outputFile = await runCleanup(scenario, false);

		const tags = remoteTags(scenario.origin);
		assert.ok(tags.has('widget#1'), 'live release tag must survive');
		assert.ok(tags.has('widget#latest'), 'live #latest must survive');
		assert.ok(tags.has('widget/feature-branch#1'), 'branch tag of a live branch must survive');
		assert.ok(tags.has('widget/master#1'), 'branch tag of the current branch must survive');
		assert.ok(tags.has('plainref'), 'a tag without # must never be touched');
		assert.ok(!tags.has('widget#null'), 'garbage version must be deleted');
		assert.ok(!tags.has('dead-action#latest'), 'dead action tag must be deleted');
		assert.ok(!tags.has('widget/dead-branch#1'), 'dead branch tag must be deleted');
		assert.equal(readOutputValue(outputFile, 'deleted-count'), '3');
	} finally {
		rmSync(scenario.dir, { recursive: true, force: true });
	}
});

test('a dry run reports deletions without performing them', async () => {
	const scenario = makeScenario();
	try {
		const outputFile = await runCleanup(scenario, true);

		const tags = remoteTags(scenario.origin);
		assert.ok(tags.has('widget#null'), 'dry run must not delete');
		assert.ok(tags.has('dead-action#latest'), 'dry run must not delete');
		assert.ok(tags.has('widget/dead-branch#1'), 'dry run must not delete');
		assert.equal(readOutputValue(outputFile, 'deleted-count'), '0');
	} finally {
		rmSync(scenario.dir, { recursive: true, force: true });
	}
});

test('an unreachable origin fails loudly instead of sweeping blind', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tag-cleanup-broken-'));
	try {
		const repo = join(dir, 'repo');
		mkdirSync(repo, { recursive: true });
		sh(repo, 'init', '--quiet');
		sh(repo, 'config', 'user.email', 't@example.com');
		sh(repo, 'config', 'user.name', 'test');
		sh(repo, 'remote', 'add', 'origin', join(dir, 'missing.git'));

		await assert.rejects(() => run({ cwd: repo, dryRun: false, currentBranch: 'master' }));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
