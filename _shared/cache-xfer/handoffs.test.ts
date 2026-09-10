import assert from 'node:assert/strict';
import {test} from 'node:test';
import {restoreEntries, saveEntries} from './handoffs';

test('save: a string is one path, a list or a block scalar is several', () => {
	assert.deepEqual(saveEntries({a: 'bin', b: ['pkg/tool', 'pkg/include'], c: 'x.com\ny.com\n'}), [
		{name: 'a', paths: ['bin']},
		{name: 'b', paths: ['pkg/tool', 'pkg/include']},
		{name: 'c', paths: ['x.com', 'y.com']}
	]);
});

test('save: an empty document, a list, a non-string path and an empty list are named defects', () => {
	assert.throws(() => saveEntries(null), /'save' is empty/);
	assert.throws(() => saveEntries(['a']), /must be a YAML mapping.*got a list/);
	assert.throws(() => saveEntries('a: b'), /must be a YAML mapping.*got string/);
	assert.throws(() => saveEntries({}), /names no hand-off/);
	assert.throws(() => saveEntries({a: 3}), /hand-off 'a' needs a path, got 3/);
	assert.throws(() => saveEntries({a: ''}), /hand-off 'a' needs a path/);
	assert.throws(() => saveEntries({a: []}), /hand-off 'a' lists no path/);
	assert.throws(() => saveEntries({a: [null]}), /hand-off 'a' needs a path, got null/);
});

test('restore: each name maps to one directory', () => {
	assert.deepEqual(restoreEntries({'ape-Linux': 'binaries/ape-Linux', 'ape-macOS': ' binaries/ape-macOS '}), [
		{name: 'ape-Linux', destination: 'binaries/ape-Linux'},
		{name: 'ape-macOS', destination: 'binaries/ape-macOS'}
	]);
	assert.throws(() => restoreEntries({a: 'one\ntwo'}), /restores into one directory/);
	assert.throws(() => restoreEntries({a: ['one']}), /needs a path/);
	assert.throws(() => restoreEntries(undefined), /'restore' is empty/);
});
