import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {guard, neuteredSteps, workflowPath} from './guard';

test('the workflow path is the middle of GITHUB_WORKFLOW_REF', () => {
	assert.equal(workflowPath('o/r/.github/workflows/ci.yml@refs/heads/main'), '.github/workflows/ci.yml');
	assert.equal(workflowPath('o/r/.github/workflows/a/b.yml@refs/tags/v1'), '.github/workflows/a/b.yml');
	assert.equal(workflowPath('too/short'), undefined);
});

const workflow = (extra: string) => `name: CI
on:
  push:
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: wow-look-at-my/actions@ste-lint#latest
${extra}      - run: node tools/check-links.mjs
`;

test('a step allowed to fail is found, and a plain one is not', () => {
	assert.deepEqual(neuteredSteps(workflow('')), []);
	const found = neuteredSteps(workflow('        continue-on-error: true\n'));
	assert.equal(found.length, 1);
	assert.match(found[0], /uses: wow-look-at-my\/actions@ste-lint#latest/);
});

// common-checks runs ste-lint, so a caller that lets the wrapper fail lets
// this check fail with it.
test('the common-checks step that calls this action counts as this step', () => {
	const wrapped = `name: CI
jobs:
  checks:
    steps:
      - uses: wow-look-at-my/actions@common-checks#latest
        continue-on-error: true
`;
	const found = neuteredSteps(wrapped);
	assert.equal(found.length, 1);
	assert.match(found[0], /uses: wow-look-at-my\/actions@common-checks#latest/);
});

test('continue-on-error on a different step is not this step', () => {
	const other = `name: CI
jobs:
  checks:
    steps:
      - uses: wow-look-at-my/actions@ste-lint#latest
      - run: flaky
        continue-on-error: true
`;
	assert.deepEqual(neuteredSteps(other), []);
});

function workspaceWith(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'ste-guard-'));
	mkdirSync(join(dir, '.github', 'workflows'), {recursive: true});
	writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), text);
	return dir;
}

test('the ref this action runs as is reported on every run', () => {
	const g = guard({actionRef: 'ste-lint#3'});
	assert.deepEqual(g.notes, ['ste-lint ref: ste-lint#3']);
});

test('a neutered step fails the run', () => {
	const dir = workspaceWith(workflow('        continue-on-error: true\n'));
	const g = guard({workspace: dir, workflowRef: 'o/r/.github/workflows/ci.yml@refs/heads/main', actionRef: 'ste-lint#latest'});
	assert.match(g.failure ?? '', /runs under continue-on-error/);
});

test('an ordinary step passes and reports nothing unknown', () => {
	const dir = workspaceWith(workflow(''));
	const g = guard({workspace: dir, workflowRef: 'o/r/.github/workflows/ci.yml@refs/heads/main'});
	assert.equal(g.failure, undefined);
	assert.deepEqual(g.unknown, []);
});

// Never silent: a check it could not make is a thing it says it does not know.
test('an unreadable workflow is named as unknown, not passed over', () => {
	const g = guard({workspace: '/nonexistent', workflowRef: 'o/r/.github/workflows/ci.yml@refs/heads/main'});
	assert.equal(g.failure, undefined);
	assert.equal(g.unknown.length, 1);
	assert.match(g.unknown[0], /not readable/);

	const h = guard({workspace: '/tmp'});
	assert.match(h.unknown[0], /no workflow reference/);
});
