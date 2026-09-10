import assert from 'node:assert/strict';
import {test} from 'node:test';
import {blocks, lineAt} from './blocks';
import {blankSpan, clauseBefore, lintText, sentences, stripCode, wordCount} from './lint';

const lines = (s: string) => s.split('\n');

test('a paragraph becomes one block, and every line maps back', () => {
	const [b] = blocks(lines('one two\nthree four\nfive six'));
	assert.equal(b.text, 'one two three four five six');
	assert.equal(b.startLine, 1);
	assert.equal(lineAt(b, 0), 1);
	assert.equal(lineAt(b, 8), 2);
	assert.equal(lineAt(b, 20), 3);
});

test('a blank line, a heading, a quote and a table row each end a block', () => {
	assert.equal(blocks(lines('a\n\nb')).length, 2);
	assert.equal(blocks(lines('a\n# h\nb')).length, 2);
	assert.equal(blocks(lines('a\n> q\nb')).length, 2);
	assert.equal(blocks(lines('a\n| c |\nb')).length, 2);
});

test('each list item is its own block, and its continuation stays with it', () => {
	const b = blocks(lines('- first item\n  continues here\n- second item'));
	assert.equal(b.length, 2);
	assert.equal(b[0].text, 'first item continues here');
	assert.equal(b[0].list, true);
	assert.equal(b[1].text, 'second item');
});

// YAML frontmatter is data, not a wrapped sentence: one key per line is the
// correct shape, and a checker that saw it as prose flagged it as a broken wrap.
test('YAML frontmatter is skipped whole, not read as an unjoined wrap', () => {
	const b = blocks(lines('---\nifenv: SOME_FLAG\n---\n# Title\n\nBody text here.'));
	assert.deepEqual(
		b.map((x) => x.text),
		['Body text here.'], // the heading is skippable too, same as any other heading
	);
	assert.equal(lintText('a.md', '---\nifenv: SOME_FLAG\n---\n\nBody text here.').wrappedLines.length, 0);
});

test('a --- that is not frontmatter, because it does not open the file, is left alone', () => {
	// A mid-file "---" is a horizontal rule, not frontmatter -- frontmatterEnd only
	// looks at line 0, so this one becomes its own (harmless, word-free) block.
	const b = blocks(lines('Body first.\n\n---\n\nMore body.'));
	assert.deepEqual(
		b.map((x) => x.text),
		['Body first.', '---', 'More body.'],
	);
});

// The loophole this closes: prose is hard-wrapped, so measuring one physical
// line at a time made the sentence cap unenforceable.
test('a sentence wrapped over three lines is measured whole', () => {
	const wrapped = 'A sentence that runs past the cap because it keeps\ngoing well beyond what any reader can hold in\none breath, and then it carries on even further too.';
	const f = lintText('a.md', wrapped);
	assert.equal(f.hardLong.length, 1);
	assert.match(f.hardLong[0], /^a\.md:1: 2[6-9] words/);
});

test('a finding names the line its sentence starts on, not the block', () => {
	const f = lintText('a.md', 'Short one.\nShort two.\nThis line would fail.');
	assert.deepEqual(f.bannedModals, ['a.md:3: "would"']);
});

test('a banned tense split across a wrap is caught', () => {
	const f = lintText('a.md', 'The value has\nbeen replaced by the loader.');
	assert.equal(f.complexTense.length, 1);
	assert.match(f.complexTense[0], /a\.md:1: "has been"/);
});

test('a comma joining two clauses fails, the same as the semicolon it replaces', () => {
	const f = lintText('a.md', 'The queue is a display, it never takes focus.');
	assert.equal(f.commaSplices.length, 1);
	assert.match(f.commaSplices[0], /a\.md:1: ", it never takes"/);

	const g = lintText('b.md', 'The queue is a display, and it never takes focus.');
	assert.equal(g.commaSplices.length, 1);
});

test('an introductory phrase before a clause is not a comma splice', () => {
	for (const clean of [
		'Under the alt screen, there is no scrollback to select from.',
		'In that case, the answer is no.',
		'The card shows a model, a theme, and a diff.',
		'On a resize, a reflow is queued.',
	]) {
		assert.deepEqual(lintText('a.md', clean).commaSplices, [], clean);
	}
});

test('clauseBefore stops at the nearest boundary, not the last full stop', () => {
	assert.equal(clauseBefore('One is done. Two is next and three', 29), 'Two is next and ');
	assert.equal(clauseBefore('Only one clause here', 9), 'Only one ');
	// The comma follows a phrase, and the clause before it is two boundaries back.
	assert.equal(clauseBefore('This matters: on a slow link, the diff', 28), 'on a slow link');
});

test('a comma after a subordinate clause is correct English, not a splice', () => {
	for (const clean of [
		'If a surface other than a terminal is wanted, it gets designed then.',
		'When the run ends and nothing is queued, the hook is dispatched.',
		'Because the value is unknown, it renders as a dash.',
		'While the read is in flight, the pane shows what it has.',
	]) {
		assert.deepEqual(lintText('a.md', clean).commaSplices, [], clean);
	}
});

// A blanked span used to leave pure whitespace. A sentence that opened with a
// code span then lost its capital and never split from the one before it, and a
// technical name counted as zero words. Both made a sentence measure too long.
test('a code span counts as one word and can open a sentence', () => {
	assert.equal(blankSpan('`Foo.Bar`'), 'X        ');
	assert.equal(wordCount(stripCode('`a` `b` `c`')), 3);
	const f = lintText('a.md', 'The order is fixed. `02-contracts.md` fixes it there, and nothing else does.');
	assert.deepEqual(f.hardLong, []);
});

test('a blanked span keeps its length, so a finding still names its line', () => {
	const f = lintText('a.md', 'one\ntwo `code here`\nThis line would fail.');
	assert.deepEqual(f.bannedModals, ['a.md:3: "would"']);
});

// A sentence that opens with one of these used to join the sentence before it,
// and the pair then measured as one long sentence.
test('a sentence opens on a section sign, a quote or a non-ASCII capital', () => {
	for (const opener of ['§3a says so.', '"Quoted" is fine.', 'Ähnlich here.', '¶ 4 says so.']) {
		const f = lintText('a.md', `First sentence here. ${opener}`);
		assert.deepEqual(f.hardLong, []);
		assert.equal(sentences(`First sentence here. ${opener}`).length, 2, opener);
	}
});
