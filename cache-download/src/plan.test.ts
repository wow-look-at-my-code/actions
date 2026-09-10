import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inputLines, planDownloads} from './plan';

test('inputLines drops blanks and trims each line', () => {
	assert.deepEqual(inputLines('a\r\n  b \n\n'), ['a', 'b']);
	assert.deepEqual(inputLines(''), []);
});

test('no name is nameless discovery into the one path', () => {
	assert.deepEqual(planDownloads([], []), []);
	assert.deepEqual(planDownloads([], ['out']), []);
	assert.throws(() => planDownloads([], ['a', 'b']), /nameless discovery/);
});

test('one name restores into the path, or the workspace', () => {
	assert.deepEqual(planDownloads(['x'], []), [{name: 'x', destination: '.'}]);
	assert.deepEqual(planDownloads(['x'], ['out']), [{name: 'x', destination: 'out'}]);
	assert.throws(() => planDownloads(['x'], ['a', 'b']), /one hand-off/);
});

test('several names under one path each get their own directory', () => {
	assert.deepEqual(planDownloads(['ape-Linux', 'ape-macOS'], ['binaries']), [
		{name: 'ape-Linux', destination: 'binaries/ape-Linux'},
		{name: 'ape-macOS', destination: 'binaries/ape-macOS'}
	]);
	assert.deepEqual(planDownloads(['a', 'b'], []), [
		{name: 'a', destination: './a'},
		{name: 'b', destination: './b'}
	]);
});

test('several names pair with as many paths, in order', () => {
	assert.deepEqual(planDownloads(['a', 'b'], ['one', 'two']), [
		{name: 'a', destination: 'one'},
		{name: 'b', destination: 'two'}
	]);
	assert.throws(() => planDownloads(['a', 'b', 'c'], ['one', 'two']), /one path, or one per name/);
});
