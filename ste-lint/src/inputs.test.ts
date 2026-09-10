import assert from 'node:assert/strict';
import {test} from 'node:test';
import {capped, STE_MAX_WORDS} from './inputs';

test('an empty input takes the default', () => {
	assert.equal(capped('warn-max-words', '', 20), 20);
	assert.equal(capped('warn-max-words', '   ', 20), 20);
});

test('a stricter value is accepted, because a house style may be stricter', () => {
	assert.equal(capped('hard-max-words', '15', 25), 15);
	assert.equal(capped('warn-max-words', '25', 20), 25);
});

// The loophole this closes: nothing stopped a workflow raising the cap until
// its own prose passed, in one line of YAML that read like a setting.
test('a value above the standard is refused, by name and by number', () => {
	assert.throws(() => capped('hard-max-words', '26', 25), /hard-max-words=26 is above ASD-STE100's own cap of 25/);
	assert.throws(() => capped('hard-max-words', '500', 25), /removes it/);
	assert.throws(() => capped('warn-max-words', '40', 20), /warn-max-words=40/);
});

test('a value that is not a positive whole number is refused', () => {
	for (const bad of ['0', '-3', '2.5', 'twenty', 'true']) {
		assert.throws(() => capped('hard-max-words', bad, 25), /positive whole number/, bad);
	}
});

test('the ceiling is the standard s number', () => {
	assert.equal(STE_MAX_WORDS, 25);
});
