// The mechanical subset of ASD-STE100 (Simplified Technical English): sentence
// length, contractions, banned modal verbs, semicolons, dictionary word choice, and
// (as warnings) complex verb tenses, passive voice, and long noun clusters. This is
// not full conformance -- the standard's own FAQ says ASD and the STEMG do not
// endorse a tool that claims to be "fully compliant," and several writing rules
// need real semantic judgment a pattern cannot do -- see docs/ste-lint-spec-mapping.md.

import {blocks, isListLine, isSkippableLine, lineAt, stripMarkup} from './blocks';
import {BANNED_WORDS} from './ste100-banned-words';

export {blocks, isListLine, isSkippableLine, lineAt, stripMarkup};

export interface Options {
	hardMaxWords: number;
	warnMaxWords: number;
}

export const DEFAULTS: Options = {hardMaxWords: 25, warnMaxWords: 20};

export interface Findings {
	// Each of these fails the run.
	hardLong: string[];
	contractions: string[];
	bannedModals: string[];
	semicolons: string[];
	commaSplices: string[];
	wrappedLines: string[];
	// Each of these only warns: they are heuristics, and a heuristic that
	// fails a build teaches people to route around the check.
	warnLong: string[];
	passive: string[];
	nounClusters: string[];
	complexTense: string[];
	bannedWords: string[];
	longParagraphs: string[];
}

export function emptyFindings(): Findings {
	return {
		hardLong: [],
		contractions: [],
		bannedModals: [],
		semicolons: [],
		commaSplices: [],
		wrappedLines: [],
		warnLong: [],
		passive: [],
		nounClusters: [],
		complexTense: [],
		bannedWords: [],
		longParagraphs: [],
	};
}

export function hasFailures(f: Findings): boolean {
	return (
		f.hardLong.length > 0 ||
		f.contractions.length > 0 ||
		f.bannedModals.length > 0 ||
		f.semicolons.length > 0 ||
		f.commaSplices.length > 0 ||
		f.wrappedLines.length > 0
	);
}

const CONTRACTION_RE =
	/\b(?:can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|wouldn't|shouldn't|couldn't|mustn't|hasn't|haven't|hadn't|it's|that's|there's|here's|let's|we're|they're|you're|i'm|i've|we've|they've|you've|i'll|we'll|they'll|you'll|he's|she's|who's|what's)\b/gi;

// STE's approved obligation word is "must"/"must not" (dictionary rule MUST (v)).
// "could" is explicitly banned in the dictionary ("Do not use COULD (v) to show
// possibility" -- use "can"). "might" and "would" are absent from the dictionary
// entirely, same as "should" and "shall". "may" is deliberately left out: it is
// also a calendar month, and that collision would make this a false-positive trap.
const BANNED_MODAL_RE = /\b(should|shall|could|might|would)\b/gi;

const SEMICOLON_RE = /;/g;

// STE bans the semicolon (rule 8.5) because it bans welding two clauses into
// one sentence: rule 5.3 allows one instruction per sentence. A comma put in
// the semicolon's place breaks the same rule, so it fails the same way.
// Without this, the semicolon rule is one search-and-replace away from
// meaning nothing.
//
// The pattern stays narrow on purpose. An introductory phrase followed by a
// clause is ordinary English ("Under the alt screen, there is no scrollback"),
// so a comma only counts when the words BEFORE it already carry a finite verb
// of their own, and the words after it open a new clause with a subject and a
// finite verb.
const CLAUSE_SUBJECT = 'it|they|he|she|we|you|this|that|these|those|nothing|everything|nobody|the|a|an';
const FINITE_VERB =
	'is|are|was|were|has|have|had|does|do|did|can|cannot|must|will|makes|make|means|gives|gets|goes|' +
	'comes|stays|keeps|needs|wants|says|reads|holds|owns|carries|fires|runs|works|costs|counts|leaves|' +
	'starts|stops|takes|tells|turns|lives|looks|sits|sends|renders|answers|reports|names|breaks|ends';
const FINITE_VERB_RE = new RegExp(`\\b(?:${FINITE_VERB})\\b`, 'i');
const COMMA_SPLICE_RE = new RegExp(
	`,\\s+(?:(?:and|but|so|yet|then)\\s+)?(?:${CLAUSE_SUBJECT})\\s+(?:\\w+\\s+){0,2}?(?:not\\s+)?(?:${FINITE_VERB})\\b`,
	'gi',
);

// True when the text before a comma is already a clause, which is what makes
// the clause after it a second one rather than the sentence's first.
export function isClause(before: string): boolean {
	const words = before.trim();
	if (SUBORDINATOR_RE.test(words)) return false;
	return FINITE_VERB_RE.test(words) && words.split(/\s+/).length >= 3;
}

// Rule 3.2: STE approves only the infinitive, the imperative, the simple present,
// simple past, simple future, and the past participle as an adjective. "has/have/had
// done X" (present/past perfect) and "will have done X" (future perfect) are named as
// banned complex constructions in rule 3.4. A regular past participle ends "-ed"; the
// rest of this list is the common irregular set.
const IRREGULAR_PARTICIPLES = [
	'been', 'become', 'begun', 'bent', 'bought', 'broken', 'brought', 'built', 'burst', 'caught',
	'chosen', 'come', 'cut', 'dealt', 'done', 'drawn', 'driven', 'eaten', 'fallen', 'fed', 'felt',
	'fought', 'found', 'flown', 'forgotten', 'frozen', 'given', 'gone', 'gotten', 'got', 'grown',
	'had', 'heard', 'held', 'hidden', 'hit', 'hurt', 'kept', 'known', 'laid', 'left', 'lent', 'let',
	'lit', 'lost', 'made', 'meant', 'met', 'paid', 'put', 'read', 'ridden', 'risen', 'run', 'said',
	'seen', 'sent', 'set', 'shown', 'shut', 'sold', 'sought', 'spent', 'spoken', 'spread', 'stood',
	'stolen', 'struck', 'swum', 'taken', 'taught', 'thought', 'thrown', 'told', 'understood', 'won',
	'worn', 'written',
];
const PARTICIPLE_PATTERN = `(?:[a-z]+ed|${IRREGULAR_PARTICIPLES.join('|')})`;
const PERFECT_TENSE_RE = new RegExp(
	`\\b(?:will\\s+have|has|have|had)\\b(?:\\s+(?:not|never|already|just|recently|still))?\\s+(${PARTICIPLE_PATTERN})\\b`,
	'gi',
);

// Rule 3.2/3.5: the present and past progressive ("is/was adjusting") are named as
// banned tenses. STE approves a handful of "-ing" words as a noun (lighting, opening,
// routing, servicing), an adjective (mating, missing, remaining), a pronoun
// (something), and a preposition (during). Only the adjective, pronoun, and
// preposition forms are exempt here: right after a bare "is/are/was/were" with no
// article, the noun forms almost always signal the banned progressive tense, not the
// approved noun (which normally needs an article: "is an opening", not "is opening").
const PROGRESSIVE_EXEMPT = ['mating', 'missing', 'remaining', 'something', 'during'];
const PROGRESSIVE_TENSE_RE = new RegExp(
	`\\b(?:is|are|was|were|am|been)\\b(?:\\s+not)?\\s+(?!(?:${PROGRESSIVE_EXEMPT.join('|')})\\b)([a-z]+ing)\\b`,
	'gi',
);

// Rule 1.1-1.3: a word not in the dictionary, or used with an unapproved meaning,
// is not STE. BANNED_WORDS covers only the words this checker can safely flag by
// text alone (see ste100-banned-words.ts for what was excluded and why).
const WORD_TOKEN_RE = /[a-z][a-z'-]*/gi;

// Rule 3.3: use the active voice. This matches "is deleted" and its family, and
// it runs over a joined block, so a wrap between the verb and the participle no
// longer hides it.
const PASSIVE_RE = /\b(?:is|are|was|were|be|been|being)\s+\w+ed\b/gi;

// The words between the previous clause boundary and `index`. The comma-splice
// rule asks whether THOSE words are a clause, so it must stop at the nearest
// comma, colon or dash rather than run back to the last full stop: in "which is
// why repaints matter: on a slow link, the diff is the frame rate", the words
// before the comma are "on a slow link", not the whole sentence.
export function clauseBefore(text: string, index: number): string {
	const head = text.slice(0, index);
	let stop = -1;
	for (const mark of ['. ', '! ', '? ', ': ', '; ', ', ', ' -- ', '\u2014', '\u2013']) {
		stop = Math.max(stop, head.lastIndexOf(mark) < 0 ? -1 : head.lastIndexOf(mark) + mark.length);
	}
	return stop < 0 ? head : head.slice(stop);
}

// A comma after a subordinate clause is correct English and not a splice: "If
// the surface is wanted, it gets designed then" joins a dependent clause to its
// main one. Only two independent clauses are the thing rule 5.3 bans.
const SUBORDINATOR_RE =
	/^(?:(?:and|but|so|or|yet)\s+)?(?:if|when|whenever|where|wherever|while|because|although|though|unless|since|after|before|until|once|whether|provided|assuming|given|for)\b/i;

// Words too ordinary to be part of a noun cluster.
const STOPWORDS = new Set([
	'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'was',
	'were', 'be', 'been', 'must', 'not', 'never', 'always', 'you', 'your', 'it', 'its', 'this',
	'that', 'these', 'those', 'if', 'when', 'where', 'which', 'who', 'as', 'at', 'by', 'from',
	'into', 'than', 'then', 'so', 'do', 'does', 'did', 'can', 'will', 'would', 'no', 'yes', 'one',
	'each', 'every', 'only', 'also', 'more', 'most', 'all', 'any', 'none', 'same',
]);

// Replaces a span with one letter and then spaces. The length is unchanged, so
// every finding still points at the line it came from. The letter is what makes
// the span countable as the one word it is, and what lets a sentence that opens
// with it still split from the sentence before.
export function blankSpan(span: string): string {
	return span.replace(/[^\n]/g, ' ').replace(' ', 'X');
}

export function stripCode(text: string): string {
	const out: string[] = [];
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*(`{3,}|~{3,})/.test(line)) {
			inFence = !inFence;
			out.push('');
			continue;
		}
		if (inFence) {
			out.push('');
			continue;
		}
		out.push(line.replace(/`[^`]*`/g, blankSpan));
	}
	return out.join('\n');
}

// A quotation is someone else's voice, so the rules do not apply to it. A span
// may cross a line break, which keeps a quote wrapped across lines intact, and
// it stops at a blank line.
//
// The blank line is the important half. Pairing quotes across a whole document
// means one unbalanced quote re-pairs every quote after it, and each of those
// mis-paired spans blanks real prose. That is a false negative the reader
// cannot see, on a checker whose findings fail a build.
export function stripQuotedSpans(text: string): string {
	return text.replace(/"(?:[^"\n]|\n(?!\s*\n))*?"/g, blankSpan);
}

export function sentences(text: string): string[] {
	return text.split(/(?<=[.!?])\s+(?=[\p{Lu}0-9(`'"\u00a7\u00b6\u201c\u2018])/u);
}

// Rule 8.5: text in parentheses counts as one word, whatever it contains.
// Collapsed before the split so a reference like "(refer to paragraphs 2 thru 5)"
// does not inflate the count against the sentence-length caps.
export function wordCount(sentence: string): number {
	const collapsed = sentence.replace(/\([^()]*\)/g, ' (x) ');
	return collapsed.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w)).length;
}

// A run of four or more content words with nothing between them is the noun
// string STE tells you to break up (rule 2.1: no more than three words).
export function nounRuns(line: string): string[] {
	const runs: string[] = [];
	let run: string[] = [];
	for (const w of line.split(/\s+/).filter(Boolean)) {
		const bare = w.replace(/[^a-zA-Z]/g, '');
		if (bare.length >= 3 && !STOPWORDS.has(bare.toLowerCase())) {
			run.push(bare);
		} else {
			if (run.length >= 4) runs.push(run.join(' '));
			run = [];
		}
	}
	if (run.length >= 4) runs.push(run.join(' '));
	return runs;
}

export function lintText(name: string, text: string, opts: Options = DEFAULTS, into = emptyFindings()): Findings {
	const source = stripQuotedSpans(stripCode(text)).split('\n');

	// Rule 6.6: no more than six sentences in a paragraph. A paragraph is a run of
	// blocks that touch in the source; a list item never adds to the count, because
	// the standard's own worked example counts an entire intro sentence plus its
	// vertical list as ONE sentence -- the intro line supplies that one sentence.
	let paragraphStartLine = 0;
	let paragraphSentences = 0;
	let previousEndLine = -1;
	const flushParagraph = () => {
		if (paragraphSentences > 6) {
			into.longParagraphs.push(`${name}:${paragraphStartLine}: ${paragraphSentences} sentences in one paragraph`);
		}
		paragraphSentences = 0;
	};

	for (const block of blocks(source)) {
		const {text: joined} = block;
		const at = (index: number) => `${name}:${lineAt(block, index)}`;

		if (block.startLine !== previousEndLine + 1) {
			flushParagraph();
			paragraphStartLine = block.startLine;
		}
		previousEndLine = block.starts[block.starts.length - 1].line;
		if (!block.list) paragraphSentences += sentences(joined).length;

		// A paragraph is one line. A hard wrap is one author's guess at one
		// reader's window, frozen into the file, and every later edit reflows
		// the block and buries the real change in the diff. It also hides
		// length: nobody writes twelve lines by accident, and everybody
		// writes the same text as one wrapped paragraph by accident.
		for (let i = 1; i < block.starts.length; i++) {
			const line = block.starts[i].line;
			into.wrappedLines.push(`${name}:${line}: continues line ${block.starts[i - 1].line}`);
		}

		let m: RegExpExecArray | null;
		CONTRACTION_RE.lastIndex = 0;
		while ((m = CONTRACTION_RE.exec(joined))) into.contractions.push(`${at(m.index)}: "${m[0]}"`);
		BANNED_MODAL_RE.lastIndex = 0;
		while ((m = BANNED_MODAL_RE.exec(joined))) into.bannedModals.push(`${at(m.index)}: "${m[0]}"`);
		SEMICOLON_RE.lastIndex = 0;
		while ((m = SEMICOLON_RE.exec(joined))) into.semicolons.push(`${at(m.index)}: ";"`);
		COMMA_SPLICE_RE.lastIndex = 0;
		while ((m = COMMA_SPLICE_RE.exec(joined))) {
			if (isClause(clauseBefore(joined, m.index))) into.commaSplices.push(`${at(m.index)}: "${m[0].trim()}"`);
		}
		PERFECT_TENSE_RE.lastIndex = 0;
		while ((m = PERFECT_TENSE_RE.exec(joined))) {
			into.complexTense.push(`${at(m.index)}: "${m[0]}" (perfect tense, and STE allows only simple tenses)`);
		}
		PROGRESSIVE_TENSE_RE.lastIndex = 0;
		while ((m = PROGRESSIVE_TENSE_RE.exec(joined))) {
			into.complexTense.push(`${at(m.index)}: "${m[0]}" (progressive tense, and STE allows only simple tenses)`);
		}

		let offset = 0;
		for (const s of sentences(joined)) {
			const n = wordCount(s);
			if (n > opts.hardMaxWords) {
				into.hardLong.push(`${at(offset)}: ${n} words: "${s.slice(0, 100)}${s.length > 100 ? '...' : ''}"`);
			} else if (n > opts.warnMaxWords) {
				into.warnLong.push(`${at(offset)}: ${n} words`);
			}
			offset += s.length + 1;
		}

		PASSIVE_RE.lastIndex = 0;
		while ((m = PASSIVE_RE.exec(joined))) into.passive.push(at(m.index));
		for (const run of nounRuns(joined)) into.nounClusters.push(`${name}:${block.startLine}: "${run}"`);

		WORD_TOKEN_RE.lastIndex = 0;
		let w: RegExpExecArray | null;
		while ((w = WORD_TOKEN_RE.exec(joined))) {
			// Object.hasOwn, because a table written as an object literal answers
			// for "constructor", "toString" and every other Object.prototype
			// name with a function. That read as a banned word and threw on
			// join, so one ordinary English word crashed the whole run.
			const key = w[0].toLowerCase();
			const alts = Object.hasOwn(BANNED_WORDS, key) ? BANNED_WORDS[key] : undefined;
			if (alts) into.bannedWords.push(`${at(w.index)}: "${w[0]}" -- use ${alts.join(' or ')}`);
		}
	}
	flushParagraph();
	return into;
}

export function lintFiles(files: {name: string; text: string}[], opts: Options = DEFAULTS): Findings {
	const findings = emptyFindings();
	for (const f of files) lintText(f.name, f.text, opts, findings);
	return findings;
}

export function failureReport(f: Findings, opts: Options): string {
	const problems: string[] = [];
	if (f.hardLong.length) {
		problems.push(
			`Sentences over ${opts.hardMaxWords} words (STE's own outer bound, for a description; an instruction caps at ${opts.warnMaxWords}):\n${f.hardLong.join('\n')}`,
		);
	}
	if (f.contractions.length) problems.push(`Contractions are banned in STE:\n${f.contractions.join('\n')}`);
	if (f.bannedModals.length) {
		problems.push(
			`STE bans "should"/"shall"/"could"/"might"/"would" -- use "must"/"must not" for obligation and "can" for ability or possibility:\n${f.bannedModals.join('\n')}`,
		);
	}
	if (f.semicolons.length) {
		problems.push(`STE bans the semicolon -- use a period and start a new sentence:\n${f.semicolons.join('\n')}`);
	}
	if (f.commaSplices.length) {
		problems.push(
			'A comma joining two clauses is the semicolon STE bans, spelled differently -- ' +
				`use a period and start a new sentence:\n${f.commaSplices.join('\n')}`,
		);
	}
	if (f.wrappedLines.length) {
		problems.push(
			'A paragraph is one line -- join these back up and let the reader\'s window do the wrapping:\n' +
				f.wrappedLines.join('\n'),
		);
	}
	return problems.join('\n\n');
}
