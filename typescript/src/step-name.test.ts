import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { runsTypescriptAction, unnamedStepMessage, unnamedSteps } from './step-name';

describe('runsTypescriptAction', () => {
	it('matches the published action at any ref', () => {
		assert.equal(runsTypescriptAction('wow-look-at-my/actions@typescript#latest'), true);
		assert.equal(runsTypescriptAction('wow-look-at-my/actions@typescript#3'), true);
		assert.equal(runsTypescriptAction('wow-look-at-my/actions@typescript'), true);
	});

	it('matches a local checkout path', () => {
		assert.equal(runsTypescriptAction('./typescript'), true);
		assert.equal(runsTypescriptAction('./typescript/'), true);
	});

	it('does not match another action whose name merely contains it', () => {
		assert.equal(runsTypescriptAction('./typescript/test'), false);
		assert.equal(runsTypescriptAction('wow-look-at-my/actions@typescript-step-names#latest'), false);
		assert.equal(runsTypescriptAction('actions/setup-node@v4'), false);
	});

	it('ignores a non-string uses', () => {
		assert.equal(runsTypescriptAction(undefined), false);
		assert.equal(runsTypescriptAction(42), false);
	});
});

describe('unnamedSteps', () => {
	const doc = {
		jobs: {
			build: {
				steps: [
					{ uses: 'actions/checkout@v4' },
					{ uses: './typescript', with: { script: 'core.info("x")' } },
					{ name: 'Do the thing', uses: 'wow-look-at-my/actions@typescript#latest' },
					{ name: '   ', uses: './typescript' },
					{ run: 'echo hi' },
				],
			},
		},
	};

	it('reports the 1-based position of each unnamed typescript step', () => {
		assert.deepEqual(unnamedSteps(doc, 'build'), [2, 4]);
	});

	it('is quiet for a job it cannot find, which is the composite-action case', () => {
		assert.deepEqual(unnamedSteps(doc, 'other'), []);
		assert.deepEqual(unnamedSteps({}, 'build'), []);
		assert.deepEqual(unnamedSteps({ jobs: { build: null } }, 'build'), []);
	});

	it('tolerates a null entry in the steps list', () => {
		assert.deepEqual(unnamedSteps({ jobs: { build: { steps: [null, { uses: './typescript' }] } } }, 'build'), [2]);
	});
});

describe('unnamedStepMessage', () => {
	it('names the workflow, the job and each position', () => {
		const msg = unnamedStepMessage('.github/workflows/ci.yml', 'build', [2, 4]);
		assert.match(msg, /\.github\/workflows\/ci\.yml/);
		assert.match(msg, /job 'build'/);
		assert.match(msg, /step 2, step 4/);
		assert.match(msg, /name:/);
	});
});
