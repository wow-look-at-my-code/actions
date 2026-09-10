import {strict as assert} from 'node:assert';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {DEFAULTS, emptyFindings, Findings, lintText} from './lint';

const DIR = join(__dirname, '..', 'fixtures');
const HEADER = /^<!--\s*expect:\s*(.*?)\s*-->/;

// A fixture names the counts and nothing else, so a rule it says nothing about
// is free to change. The named ones are the reason the file is here.
export function expectations(text: string): Record<string, number> {
	const first = text.split('\n')[0] ?? '';
	const m = HEADER.exec(first);
	if (m === null) throw new Error('no "<!-- expect: ... -->" header on the first line');
	const out: Record<string, number> = {};
	for (const pair of m[1].split(/\s+/)) {
		const eq = pair.indexOf('=');
		if (eq < 1) throw new Error(`"${pair}" is not name=count`);
		const name = pair.slice(0, eq);
		const n = Number(pair.slice(eq + 1));
		if (!Number.isInteger(n) || n < 0) throw new Error(`"${pair}" has no whole-number count`);
		if (!(name in emptyFindings())) throw new Error(`"${name}" is not a rule this checker reports`);
		out[name] = n;
	}
	if (Object.keys(out).length === 0) throw new Error('the expect header names no rule');
	return out;
}

// The suffix keeps these off `**/*.md`. common-checks lints every markdown
// file in a repository and takes no path to opt out, so a fixture that broke
// the rules on purpose failed the gate that this checker is the gate for.
const files = readdirSync(DIR).filter((f) => f.endsWith('.md.fixture'));

test('there are fixtures to walk', () => {
	assert.ok(files.length > 0, `no fixtures in ${DIR}`);
});

for (const file of files) {
	test(`fixture ${file}`, () => {
		const text = readFileSync(join(DIR, file), 'utf8');
		const want = expectations(text);
		const got = lintText(file, text, DEFAULTS) as unknown as Record<string, string[]>;
		for (const [name, count] of Object.entries(want)) {
			assert.equal(got[name].length, count, `${name}: ${JSON.stringify(got[name])}`);
		}
	});
}

test('a fixture with no expect header fails the run', () => {
	assert.throws(() => expectations('# nothing\n'), /expect/);
});

test('an expect header naming an unknown rule fails the run', () => {
	assert.throws(() => expectations('<!-- expect: elbows=1 -->\n'), /not a rule/);
});

test('every failing rule is named by at least one fixture', () => {
	const named = new Set<string>();
	for (const file of files) {
		for (const rule of Object.keys(expectations(readFileSync(join(DIR, file), 'utf8')))) named.add(rule);
	}
	const failing: (keyof Findings)[] = [
		'hardLong',
		'contractions',
		'bannedModals',
		'semicolons',
		'commaSplices',
		'wrappedLines',
	];
	for (const rule of failing) {
		assert.ok(named.has(rule), `no fixture asserts on ${rule}`);
	}
});
