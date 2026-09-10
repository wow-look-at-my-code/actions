import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
	DEFAULTS,
	failureReport,
	hasFailures,
	isSkippableLine,
	lintFiles,
	lintText,
	nounRuns,
	sentences,
	stripCode,
	stripMarkup,
	stripQuotedSpans,
	wordCount,
} from './lint';

const words = (n: number) => Array.from({length: n}, (_, i) => `word${i}`).join(' ') + '.';

test('a sentence over the hard cap fails', () => {
	const f = lintText('a.md', words(26));
	assert.equal(f.hardLong.length, 1);
	assert.match(f.hardLong[0], /^a\.md:1: 26 words/);
	assert.equal(hasFailures(f), true);
});

test('a sentence between the caps only warns', () => {
	const f = lintText('a.md', words(22));
	assert.equal(f.hardLong.length, 0);
	assert.equal(f.warnLong.length, 1);
	assert.equal(hasFailures(f), false);
});

test('a sentence at the cap passes', () => {
	const f = lintText('a.md', words(25));
	assert.equal(f.hardLong.length, 0);
	assert.equal(f.warnLong.length, 1);
});

test('the caps are configurable', () => {
	const f = lintText('a.md', words(12), {hardMaxWords: 10, warnMaxWords: 5});
	assert.equal(f.hardLong.length, 1);
});

test('contractions fail, and every finding names its line', () => {
	const f = lintText('a.md', 'Line one.\nIt is fine.\nThat cannot work.\nIt is not what it should be.');
	assert.deepEqual(f.contractions, []);

	const g = lintText('b.md', 'first\nIt does not work.\nThat is fine.');
	assert.deepEqual(g.contractions, []);

	const h = lintText('c.md', "one\ntwo\nIt doesn't work.");
	assert.deepEqual(h.contractions, ['c.md:3: "doesn\'t"']);
});

test('should, shall, could, might, and would fail because STE says must or can', () => {
	const f = lintText('a.md', 'You should run it.\nIt shall be run.\nThis could fail.\nIt might fail.\nThis would fail.');
	assert.equal(f.bannedModals.length, 5);
	assert.match(f.bannedModals[0], /a\.md:1: "should"/);
	assert.match(f.bannedModals[1], /a\.md:2: "shall"/);
	assert.match(f.bannedModals[2], /a\.md:3: "could"/);
	assert.match(f.bannedModals[3], /a\.md:4: "might"/);
	assert.match(f.bannedModals[4], /a\.md:5: "would"/);
});

test('may is not flagged, because it collides with the calendar month', () => {
	const f = lintText('a.md', 'The release is due in May.');
	assert.equal(f.bannedModals.length, 0);
});

test('a semicolon fails because STE bans it', () => {
	const f = lintText('a.md', 'Remove the cover; then remove the seal.');
	assert.deepEqual(f.semicolons, ['a.md:1: ";"']);
	assert.equal(hasFailures(f), true);
});

test('present and past perfect fail the "only simple tenses" rule as a warning', () => {
	const f = lintText('a.md', 'The operator has adjusted the linkage.\n\nThe technician had removed the seal.');
	assert.equal(f.complexTense.length, 2);
	assert.match(f.complexTense[0], /a\.md:1: "has adjusted"/);
	assert.match(f.complexTense[1], /a\.md:3: "had removed"/);
	assert.equal(hasFailures(f), false);
});

test('future perfect fails the "only simple tenses" rule as a warning', () => {
	const f = lintText('a.md', 'The robot will have adjusted the sleeve.');
	assert.equal(f.complexTense.length, 1);
	assert.match(f.complexTense[0], /"will have adjusted"/);
});

test('present and past progressive fail the "only simple tenses" rule as a warning', () => {
	const f = lintText('a.md', 'Be careful while the door is opening.\nThe system was running when it failed.');
	assert.equal(f.complexTense.length, 2);
	assert.match(f.complexTense[0], /"is opening"/);
	assert.match(f.complexTense[1], /"was running"/);
});

test('the small set of approved "-ing" words after a "to be" verb do not warn', () => {
	const f = lintText('a.md', 'The part is missing.\nThe screws are remaining on the tray.');
	assert.equal(f.complexTense.length, 0);
});

test('"have to" and "have" plus an ordinary object do not warn', () => {
	const f = lintText('a.md', 'You have to adjust the linkage.\nThe operator will have the tool ready.');
	assert.equal(f.complexTense.length, 0);
});

test('a word banned in the ASD-STE100 dictionary warns with its approved replacement', () => {
	const f = lintText('a.md', 'Do not abandon the test procedure if the values are abnormal.');
	assert.equal(f.bannedWords.length, 2);
	assert.match(f.bannedWords[0], /a\.md:1: "abandon" -- use GO or STOP/);
	assert.match(f.bannedWords[1], /a\.md:1: "abnormal" -- use INCORRECT or UNUSUAL/);
	assert.equal(hasFailures(f), false);
});

test('a word with an approved sense elsewhere in the dictionary is not flagged', () => {
	// "as" is banned as a conjunction but approved as a preposition; this checker
	// cannot tell the senses apart by text alone, so it must not flag it at all.
	const f = lintText('a.md', 'Install the plate as a spacer, as the drawing shows.');
	assert.equal(f.bannedWords.length, 0);
});

test('should/shall/could/might/would/may are not double-flagged by the dictionary check', () => {
	const f = lintText('a.md', 'This should work, and it might, but it may not.');
	assert.equal(f.bannedWords.length, 0);
});

test('a paragraph over six sentences warns', () => {
	const sevenSentences = Array.from({length: 7}, (_, i) => `Sentence number ${i}.`).join(' ');
	const f = lintText('a.md', sevenSentences);
	assert.equal(f.longParagraphs.length, 1);
	assert.match(f.longParagraphs[0], /a\.md:1: 7 sentences in one paragraph/);
	assert.equal(hasFailures(f), false);
});

test('a paragraph at six sentences does not warn', () => {
	const sixSentences = Array.from({length: 6}, (_, i) => `Sentence number ${i}.`).join(' ');
	const f = lintText('a.md', sixSentences);
	assert.equal(f.longParagraphs.length, 0);
});

test('a blank line starts a new paragraph for the sentence count', () => {
	const para = (n: number) => Array.from({length: n}, (_, i) => `Sentence number ${i}.`).join(' ');
	const f = lintText('a.md', `${para(6)}\n\n${para(6)}`);
	assert.equal(f.longParagraphs.length, 0);
});

test('a vertical list does not add to its paragraph\'s sentence count', () => {
	const text = [
		'The fuel manifold has these primary parts:',
		'- A pressure transducer',
		'- Three fittings',
		'- A shut-off valve',
		'- A spring',
		'- A retaining ring',
		'- A ball',
		'- A seal',
	].join('\n');
	const f = lintText('a.md', text);
	assert.equal(f.longParagraphs.length, 0);
});

test('a fenced block is exempt and does not shift line numbers', () => {
	const text = ['Intro.', '```', "it doesn't matter here", '```', "It doesn't matter here."].join('\n');
	const f = lintText('a.md', text);
	assert.equal(f.contractions.length, 1);
	assert.match(f.contractions[0], /a\.md:5:/);
});

test('inline code is exempt', () => {
	assert.equal(lintText('a.md', 'Run `it doesn\'t` now.').contractions.length, 0);
});

test('a quotation is exempt because it is another voice', () => {
	assert.equal(lintText('a.md', 'The owner said "it doesn\'t work".').contractions.length, 0);
	assert.equal(lintText('a.md', `The rule is "${words(40)}".`).hardLong.length, 0);
});

test('a hard-wrapped paragraph fails, and the finding names the continuation', () => {
	const f = lintText('a.md', 'A paragraph broken\nover two lines.');
	assert.equal(f.wrappedLines.length, 1);
	assert.match(f.wrappedLines[0], /a\.md:2: continues line 1/);
	assert.equal(hasFailures(f), true);
});

test('a paragraph on one line reports no wrap, whatever its width', () => {
	assert.equal(lintText('a.md', words(40)).wrappedLines.length, 0);
});

test('a wrapped list item fails, and a second item does not', () => {
	assert.equal(lintText('a.md', '- One item.\n- A second item.').wrappedLines.length, 0);
	assert.equal(lintText('a.md', '- An item broken\n  over two lines.').wrappedLines.length, 1);
});

test('a fenced block, a table and a heading run wrap-free', () => {
	assert.equal(lintText('a.md', '```\none\ntwo\n```').wrappedLines.length, 0);
	assert.equal(lintText('a.md', '| a | b |\n| --- | --- |\n| c | d |').wrappedLines.length, 0);
	assert.equal(lintText('a.md', '# One\n## Two').wrappedLines.length, 0);
});

test('a heading, a blockquote and a table row are not sentences', () => {
	assert.equal(isSkippableLine('# A heading'), true);
	assert.equal(isSkippableLine('> quoted'), true);
	assert.equal(isSkippableLine('| a | b |'), true);
	assert.equal(isSkippableLine('Ordinary prose.'), false);
	assert.equal(lintText('a.md', `# ${words(40)}`).hardLong.length, 0);
});

test('a list marker and a link do not count as words', () => {
	assert.equal(stripMarkup('- A [linked](http://x) item'), 'A linked item');
	assert.equal(stripMarkup('1. **Bold** item'), 'Bold item');
});

test('sentences split on terminal punctuation', () => {
	assert.deepEqual(sentences('One thing. Two things! Three?'), ['One thing.', 'Two things!', 'Three?']);
	assert.equal(wordCount('One thing --- here.'), 3);
});

test('a parenthetical counts as one word, whatever it contains', () => {
	assert.equal(wordCount('Install the cover (refer to paragraphs 2 thru 5).'), 4);
	assert.equal(wordCount('Remove the valve (10, Figure 1).'), 4);

	const longParen = `(refer to ${words(20).slice(0, -1)})`;
	const f = lintText('a.md', `Install the cover ${longParen}.`);
	assert.equal(f.hardLong.length, 0);
});

test('a run of four content words is a noun cluster', () => {
	assert.deepEqual(nounRuns('the upload session finalize integrity check'), ['upload session finalize integrity check']);
	assert.deepEqual(nounRuns('the integrity check on the finalize'), []);
});

test('passive voice warns and never fails', () => {
	const f = lintText('a.md', 'The file is deleted by the hook.');
	assert.equal(f.passive.length, 1);
	assert.equal(hasFailures(f), false);
});

test('stripCode and stripQuotedSpans keep the line count', () => {
	const text = 'a\n```\nb\n```\nc';
	assert.equal(stripCode(text).split('\n').length, text.split('\n').length);
	const quoted = 'x "a\nb" y';
	assert.equal(stripQuotedSpans(quoted).split('\n').length, 2);
});

test('lintFiles accumulates across files', () => {
	const f = lintFiles([
		{name: 'a.md', text: 'You should go.'},
		{name: 'b.md', text: 'You shall go.'},
	]);
	assert.equal(f.bannedModals.length, 2);
	assert.match(f.bannedModals[0], /^a\.md/);
	assert.match(f.bannedModals[1], /^b\.md/);
});

test('the failure report names every failing category and no warning', () => {
	const f = lintFiles([{name: 'a.md', text: `You should run it. It doesn't work; ${words(30)}`}]);
	const report = failureReport(f, DEFAULTS);
	assert.match(report, /Sentences over 25 words/);
	assert.match(report, /Contractions are banned/);
	assert.match(report, /STE bans "should"\/"shall"\/"could"\/"might"\/"would"/);
	assert.match(report, /STE bans the semicolon/);
	assert.doesNotMatch(report, /passive/i);
});

test('clean prose reports nothing', () => {
	const f = lintText('a.md', '# Title\n\nThe hook reads the file. It writes the result.\n');
	assert.equal(hasFailures(f), false);
	assert.equal(failureReport(f, DEFAULTS), '');
	assert.equal(f.warnLong.length, 0);
});

test('a word that names an Object.prototype member is text, not a table entry', () => {
	// The dictionary is an object literal, so BANNED_WORDS["constructor"] used to
	// answer with a function. The run then died on alts.join rather than
	// reporting anything, and one ordinary word took every file down with it.
	const f = lintText('a.md', 'The constructor checks its own invariants.\nIts toString and valueOf do not.');
	assert.equal(f.bannedWords.length, 0);
});
