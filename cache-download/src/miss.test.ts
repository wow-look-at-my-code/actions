import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {test} from 'node:test';
import {missOutcome, namelessMissOutcome} from './miss';

// Download-only test (NOT part of the shared cache-xfer sources): pins the
// fail-if-missing semantics. The action.yml default is 'true', so an unset
// input means a missing hand-off hard-fails the step; only an explicit
// 'false' continues.

test('a miss with fail-if-missing true fails, naming the hand-off, key, prefix, and hint', () => {
	const outcome = missOutcome('go-build', 'cache-xfer-123-go-build-2', 'cache-xfer-123-go-build-', true);
	assert.equal(outcome.fail, true);
	assert.ok(outcome.message.includes("'go-build'"), outcome.message);
	assert.ok(outcome.message.includes('exact key cache-xfer-123-go-build-2'), outcome.message);
	assert.ok(outcome.message.includes('restore prefix cache-xfer-123-go-build-'), outcome.message);
	assert.match(outcome.message, /legacy key layout/);
	assert.match(outcome.message, /cache-upload with the same name/);
});

test('a miss with an explicit fail-if-missing false continues', () => {
	const outcome = missOutcome('go-build', 'cache-xfer-123-go-build-2', 'cache-xfer-123-go-build-', false);
	assert.equal(outcome.fail, false);
	assert.match(outcome.message, /fail-if-missing is false/);
	assert.ok(outcome.message.includes('exact key cache-xfer-123-go-build-2'), outcome.message);
});

test('a nameless miss names the run prefix and hard-fails by default', () => {
	const outcome = namelessMissOutcome('cache-xfer-123-', true);
	assert.equal(outcome.fail, true);
	assert.ok(outcome.message.includes('cache-xfer-123-'), outcome.message);
	// Pre-v2 producers are invisible to nameless discovery on purpose; the
	// message must say so instead of leaving the miss mysterious.
	assert.match(outcome.message, /pre-v2 cache-upload/);
	assert.match(outcome.message, /explicit name/);
});

test('a nameless miss with fail-if-missing false continues', () => {
	const outcome = namelessMissOutcome('cache-xfer-123-', false);
	assert.equal(outcome.fail, false);
	assert.match(outcome.message, /fail-if-missing is false/);
});

test("action.yml defaults fail-if-missing to 'true' (unset input = a miss hard-fails)", () => {
	const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
	const block = /fail-if-missing:\n(?:[ \t]+\S.*\n)+/.exec(actionYml);
	assert.ok(block, 'action.yml declares a fail-if-missing input');
	assert.match(block[0], /default: 'true'/);
	assert.ok(!actionYml.includes('fail-on-cache-miss'), 'the old input name must be gone');
});

test('action.yml makes name optional (nameless discovery)', () => {
	const actionYml = fs.readFileSync(path.join(__dirname, '..', 'action.yml'), 'utf8');
	const block = /  name:\n(?:[ \t]+\S.*\n)+/.exec(actionYml);
	assert.ok(block, 'action.yml declares a name input');
	assert.match(block[0], /required: false/);
});
