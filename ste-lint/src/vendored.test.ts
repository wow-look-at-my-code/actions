import assert from 'node:assert/strict';
import test from 'node:test';
import {setPaths, vendoredPaths} from './vendored';

test('setPaths keeps a path whose attribute is set', () => {
	const out = ['a.md', 'linguist-vendored', 'set', 'b.md', 'linguist-vendored', 'unspecified', ''].join('\0');
	assert.equal(setPaths(out), 'a.md');
});

test('setPaths keeps every set path', () => {
	const out = ['a.md', 'x', 'set', 'b.md', 'x', 'set', ''].join('\0');
	assert.deepEqual(setPaths(out).split('\0'), ['a.md', 'b.md']);
});

test('setPaths drops unset, unspecified and false', () => {
	const out = ['a.md', 'x', 'unset', 'b.md', 'x', 'unspecified', 'c.md', 'x', 'false', ''].join('\0');
	assert.equal(setPaths(out), '');
});

test('setPaths ignores a trailing partial triple', () => {
	assert.equal(setPaths(['a.md', 'x'].join('\0')), '');
});

test('vendoredPaths asks about every attribute and unions the answers', () => {
	const asked: string[] = [];
	const got = vendoredPaths(['a.md', 'b.md'], (attribute) => {
		asked.push(attribute);
		return attribute === 'linguist-vendored' ? 'a.md' : 'b.md';
	});
	assert.deepEqual(asked, ['linguist-vendored', 'linguist-generated']);
	assert.deepEqual([...got].sort(), ['a.md', 'b.md']);
});

test('vendoredPaths skips nothing when git fails', () => {
	const got = vendoredPaths(['a.md'], () => {
		throw new Error('no git here');
	});
	assert.equal(got.size, 0);
});

test('vendoredPaths runs no command for an empty file list', () => {
	const got = vendoredPaths([], () => {
		throw new Error('must not run');
	});
	assert.equal(got.size, 0);
});
