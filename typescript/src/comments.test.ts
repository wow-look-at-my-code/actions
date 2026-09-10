import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { findCommentBlocks } from './comments';

describe('findCommentBlocks', () => {
	it('flags two `//`-only lines in a row', () => {
		const blocks = findCommentBlocks(['// first', '// second', 'core.info("x");'].join('\n'));
		assert.deepEqual(blocks, [{ startLine: 1, endLine: 2 }]);
	});

	it('reports the full span of a longer block', () => {
		const blocks = findCommentBlocks(['const a = 1;', '// one', '// two', '// three', 'core.info(String(a));'].join('\n'));
		assert.deepEqual(blocks, [{ startLine: 2, endLine: 4 }]);
	});

	it('reports each block separately', () => {
		const blocks = findCommentBlocks(['// a', '// b', 'const x = 1;', '// c', '// d', 'void x;'].join('\n'));
		assert.deepEqual(blocks, [
			{ startLine: 1, endLine: 2 },
			{ startLine: 4, endLine: 5 },
		]);
	});

	it('allows a single comment line, and singles separated by code', () => {
		assert.deepEqual(findCommentBlocks('// just one\ncore.info("x");'), []);
		assert.deepEqual(findCommentBlocks(['// one', 'const a = 1;', '// two', 'void a;'].join('\n')), []);
	});

	it('allows a blank line between comment lines', () => {
		assert.deepEqual(findCommentBlocks(['// one', '', '// two', 'core.info("x");'].join('\n')), []);
	});

	it('ignores trailing comments after code', () => {
		assert.deepEqual(findCommentBlocks(['const a = 1; // set a', 'const b = 2; // set b'].join('\n')), []);
	});

	it('flags a comment-only line following a line whose code carries a trailing comment', () => {
		assert.deepEqual(findCommentBlocks(['// lead', 'const a = 1; // trailing', '// after', '// more', 'void a;'].join('\n')), [
			{ startLine: 3, endLine: 4 },
		]);
	});

	it('ignores `//` inside strings, template literals and regexes', () => {
		const script = [
			'const url = "https://example.com";',
			'const other = "//not a comment";',
			'const tpl = `',
			'// still a string',
			'// and so is this',
			'`;',
			'const re = /\\/\\/x/;',
			'const re2 = /\\/\\/y/;',
			'void [url, other, tpl, re, re2];',
		].join('\n');
		assert.deepEqual(findCommentBlocks(script), []);
	});

	it('handles CRLF line endings', () => {
		assert.deepEqual(findCommentBlocks('// one\r\n// two\r\ncore.info("x");'), [{ startLine: 1, endLine: 2 }]);
	});

	it('flags a `//` block indented inside a function body', () => {
		const script = ['function f() {', '\t// one', '\t// two', '\treturn 1;', '}', 'void f();'].join('\n');
		assert.deepEqual(findCommentBlocks(script), [{ startLine: 2, endLine: 3 }]);
	});

	it('leaves a JSDoc block alone', () => {
		const script = ['/**', ' * Multi-line doc comment.', ' * Second line.', ' */', 'function f() { return 1; }', 'void f();'].join('\n');
		assert.deepEqual(findCommentBlocks(script), []);
	});

	it('does not count a shebang as the first of a pair', () => {
		assert.deepEqual(findCommentBlocks('#!/usr/bin/env node\n// one\ncore.info("x");'), []);
	});

	it('returns nothing for an empty script', () => {
		assert.deepEqual(findCommentBlocks(''), []);
	});
});
