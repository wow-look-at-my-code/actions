import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { highlightSource } from './highlight';

// Expected raw escapes, spelled out independently of the implementation.
const KEYWORD = '\x1b[38;2;255;123;114m'; // #ff7b72
const STRING = '\x1b[38;2;165;214;255m'; // #a5d6ff
const COMMENT = '\x1b[38;2;139;148;158m'; // #8b949e
const NUMBER = '\x1b[38;2;121;192;255m'; // #79c0ff
const FUNCTION = '\x1b[38;2;210;168;255m'; // #d2a8ff
const CLASS = '\x1b[38;2;255;166;87m'; // #ffa657
const RESET = '\x1b[39m';

function stripAnsi(text: string): string {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('highlightSource', () => {
	it('colors keywords, numbers, strings, and comments', () => {
		const out = highlightSource('const x = 1; // note\nconst s = "hi";');
		assert.ok(out.includes(`${KEYWORD}const${RESET}`), `keyword missing in ${JSON.stringify(out)}`);
		assert.ok(out.includes(`${NUMBER}1${RESET}`), `number missing in ${JSON.stringify(out)}`);
		assert.ok(out.includes(`${STRING}"hi"${RESET}`), `string missing in ${JSON.stringify(out)}`);
		assert.ok(out.includes(`${COMMENT}// note${RESET}`), `comment missing in ${JSON.stringify(out)}`);
	});

	it('colors function and class titles', () => {
		const out = highlightSource('class Foo {}\nfunction bar(): void {}');
		assert.ok(out.includes(`${CLASS}Foo${RESET}`), `class title missing in ${JSON.stringify(out)}`);
		assert.ok(out.includes(`${FUNCTION}bar${RESET}`), `function title missing in ${JSON.stringify(out)}`);
	});

	it('keeps every line of a multi-line token self-contained', () => {
		// The block comment spans two lines: the color must close before the
		// newline and re-open after it, so viewers that reset SGR state at line
		// boundaries still color the continuation.
		const out = highlightSource('/* one\ntwo */');
		assert.equal(out, `${COMMENT}/* one${RESET}\n${COMMENT}two */${RESET}`);
	});

	it('renders template-literal substitutions as plain code, not string text', () => {
		const out = highlightSource('const t = `x${y}z`;');
		assert.ok(out.includes(`${STRING}\`x${RESET}`), `template head missing in ${JSON.stringify(out)}`);
		assert.ok(out.includes('${y}'), `substitution missing in ${JSON.stringify(out)}`);
		assert.ok(!out.includes(`${STRING}\${y}`), `substitution must not be string-colored in ${JSON.stringify(out)}`);
	});

	it('adds only color escapes — stripping them reproduces the source exactly', () => {
		const source = [
			'// leading comment',
			'import * as fs from "node:fs";',
			'const BIG = 1_000;',
			'class Foo extends Error {',
			'\tgreet(name: string): string {',
			'\t\treturn `hello ${name}, ${BIG}',
			'still the same literal`;',
			'\t}',
			'}',
			'/* block',
			'   comment */',
			'void new Foo().greet(fs.realpathSync("."));',
		].join('\n');
		assert.equal(stripAnsi(highlightSource(source)), source);
	});

	it('falls back to the plain source when highlighting fails', () => {
		const source = 'const x = 1; // stays plain';
		assert.equal(highlightSource(source, 'no-such-language'), source);
	});
});
