import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ambiguityMessage, distinctHandoffNames} from './discovery';
import {handoffKey, legacyHandoffKey} from '../../_shared/cache-xfer/lib';

// Download-only test (NOT part of the shared cache-xfer sources): pins the
// nameless-discovery semantics — the candidate-name extraction the ambiguity
// hard-error is built on.

test('distinctHandoffNames collects current-layout names of this run, in order', () => {
	const keys = [handoffKey('go-build', '123456', '1'), handoffKey('coverage', '123456', '1')];
	assert.deepEqual(distinctHandoffNames(keys, '123456'), ['go-build', 'coverage']);
});

test('distinctHandoffNames dedupes attempts — a re-run never manufactures ambiguity', () => {
	const keys = [handoffKey('go-build', '123456', '1'), handoffKey('go-build', '123456', '2'), handoffKey('go-build', '123456', '3')];
	assert.deepEqual(distinctHandoffNames(keys, '123456'), ['go-build']);
});

test('distinctHandoffNames keeps dash-digit names apart (per-job hand-off names)', () => {
	// go-toolchain#311-style names: go-build-<job id>. The terminal numeric
	// attempt segment must not swallow the job-id part of the name.
	const keys = [handoffKey('go-build-42', '123456', '1'), handoffKey('go-build', '123456', '1')];
	assert.deepEqual(distinctHandoffNames(keys, '123456'), ['go-build-42', 'go-build']);
});

test('distinctHandoffNames ignores other runs, legacy keys, and foreign namespaces', () => {
	const keys = [
		handoffKey('go-build', '999999', '1'), // another run
		legacyHandoffKey('go-build', '123456', '1'), // pre-v2 layout — invisible by design
		'setup-go-Linux-123456-1', // foreign namespace
		handoffKey('real', '123456', '1')
	];
	assert.deepEqual(distinctHandoffNames(keys, '123456'), ['real']);
});

test('ambiguityMessage names every candidate and the fix', () => {
	const msg = ambiguityMessage(['go-build-42', 'go-build']);
	assert.ok(msg.includes("'go-build-42'"), msg);
	assert.ok(msg.includes("'go-build'"), msg);
	assert.match(msg, /2 distinct hand-offs/);
	assert.match(msg, /refuses to pick/);
	assert.match(msg, /'name' input/);
});
