import * as path from 'path';

// One finding: a test living inside a GitHub Actions YAML file.
export interface Finding {
	rule: string;
	line: number;
	evidence: string;
	remedy: string;
}

// One `run:` script, with the line its first content line sits on.
export interface RunBlock {
	startLine: number;
	lines: string[];
}

// Every `run:` script in a workflow or action file. A regex walk, not a YAML
// parse: `run:` means the same thing at every depth, and a file this action
// rejects may also be a file a parser rejects.
export function findRunBlocks(content: string): RunBlock[] {
	const lines = content.split(/\r?\n/);
	const blocks: RunBlock[] = [];

	for (let index = 0; index < lines.length; index++) {
		const match = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(lines[index]);
		if (!match) {
			continue;
		}
		// A sequence item carries its key past the dash, so the block ends at
		// anything indented no further than the KEY -- `env:` under `- run:`.
		const indent = match[1].length + (match[2] ? match[2].length : 0);
		const rest = match[3].trim();
		if (!/^[|>][+-]?\d*$/.test(rest)) {
			if (rest !== '') {
				blocks.push({startLine: index + 1, lines: [rest]});
			}
			continue;
		}

		const body: string[] = [];
		let cursor = index + 1;
		for (; cursor < lines.length; cursor++) {
			const line = lines[cursor];
			if (line.trim() === '') {
				body.push('');
				continue;
			}
			if (line.search(/\S/) <= indent) {
				break;
			}
			body.push(line);
		}
		// A trailing run of blank lines belongs to the document, not the script.
		while (body.length > 0 && body[body.length - 1] === '') {
			body.pop();
		}
		if (body.length > 0) {
			blocks.push({startLine: index + 2, lines: body});
		}
		index = cursor - 1;
	}

	return blocks;
}

// A file name that only a test suite gives a file. Writing one of these from a
// workflow is how a suite ends up somewhere no engineer can run it.
const TEST_FILE_PATTERNS: RegExp[] = [
	/_test\.(?:go|py|rs|c|cc|cpp|exs?)$/,
	/\.test\.[jt]sx?$/,
	/\.spec\.[jt]sx?$/,
	/^test_[^/]*\.(?:py|c|cc|cpp)$/,
	/_spec\.rb$/,
	/Test\.(?:java|kt|cs)$/,
	/\.dats$/,
	/^conftest\.py$/
];

function namesATestFile(target: string): boolean {
	const base = path.posix.basename(target.replace(/\\/g, '/'));
	return TEST_FILE_PATTERNS.some(pattern => pattern.test(base));
}

// A comparison paired with a nonzero exit, on one line. The pairing is the
// whole test: a step that merely runs a command fails on its own exit code and
// matches nothing here.
// A bracket takes no word boundary after it, so it is spelled apart from the
// words: `[ "$x" = y ]` matched nothing while every word form matched.
const COMPARISON = String.raw`(?:(?:grep|egrep|fgrep|diff|cmp|test|jq\s+-e)\b|\[\[?)`;
const ASSERT_LINE_PATTERNS: {rule: string; pattern: RegExp}[] = [
	{
		rule: 'assertion',
		pattern: new RegExp(String.raw`${COMPARISON}[^;&|]*\|\|\s*(?:\{|\(|exit\b|echo\b|printf\b|core\b)`)
	},
	{
		rule: 'assertion',
		pattern: new RegExp(String.raw`^\s*if\s+!\s*${COMPARISON}`)
	},
	{
		rule: 'assertion',
		pattern: new RegExp(String.raw`${COMPARISON}[^;&|]*&&\s*\{?\s*(?:echo|printf)[^;]*::error`)
	},
	// One line that both annotates an error and ends the step. A `case` arm
	// spells its assertion this way, with no comparison word anywhere on it.
	{rule: 'assertion', pattern: /::error.*\bexit\s+[1-9]/}
];

// A shell function whose name says it asserts. A workflow that grows its own
// assertion vocabulary is a test framework with no test runner.
const ASSERT_HELPER = /^\s*(?:function\s+)?(assert|expect|require|must|fail_if|check_that)[A-Za-z0-9_]*\s*\(\)/;

// A redirect or a heredoc naming the file it writes.
const REDIRECT_TARGET = /(?:^|[^>\d])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/;

function evidenceOf(line: string): string {
	const trimmed = line.trim();
	return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

// Every test this run block contains.
export function findFindings(block: RunBlock): Finding[] {
	const findings: Finding[] = [];
	const annotatesAnError = block.lines.some(line => line.includes('::error'));

	block.lines.forEach((line, offset) => {
		const lineNumber = block.startLine + offset;

		const redirect = REDIRECT_TARGET.exec(line);
		const target = redirect ? (redirect[1] ?? redirect[2] ?? redirect[3] ?? '') : '';
		if (target !== '' && namesATestFile(target)) {
			findings.push({
				rule: 'test-file-written',
				line: lineNumber,
				evidence: evidenceOf(line),
				remedy: `${path.posix.basename(target)} is a test file. Commit it to the repository's own suite and let this step invoke the suite.`
			});
			return;
		}

		if (ASSERT_HELPER.test(line)) {
			findings.push({
				rule: 'assert-helper',
				line: lineNumber,
				evidence: evidenceOf(line),
				remedy: 'A workflow that defines its own assertion helper is a test framework without a test runner. Move these cases into the repository suite.'
			});
			return;
		}

		for (const {rule, pattern} of ASSERT_LINE_PATTERNS) {
			if (!pattern.test(line)) {
				continue;
			}
			// An error annotation on its own is a report. Paired with a
			// comparison that ends the step, it is an expectation.
			if (rule === 'assertion' && !annotatesAnError && !/\bexit\b/.test(block.lines.join('\n'))) {
				continue;
			}
			findings.push({
				rule,
				line: lineNumber,
				evidence: evidenceOf(line),
				remedy: 'This compares a value and fails the step on the answer, which is an assertion. Put it in the repository suite and invoke the suite here.'
			});
			return;
		}
	});

	return findings;
}

export interface UsesRef {
	value: string;
	line: number;
}

// Every `uses:` value, with its line number. Copied in shape from
// yaml-comment-block: a `uses:` key means the same thing at every depth, and an
// unquoted value ends at whitespace rather than at `#`.
export function findUses(content: string): UsesRef[] {
	const refs: UsesRef[] = [];
	content.split(/\r?\n/).forEach((line, index) => {
		const match = /^\s*(?:-\s+)?uses:\s*(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(line);
		if (!match) {
			return;
		}
		const value = match[1] ?? match[2] ?? match[3] ?? '';
		if (value !== '') {
			refs.push({value, line: index + 1});
		}
	});
	return refs;
}

// True for a `uses:` value naming a file in this repository.
export function isLocalRef(value: string): boolean {
	return value.startsWith('./');
}

// The workspace-relative paths a local `uses:` value can resolve to.
export function candidatePaths(value: string): string[] {
	const target = path.posix.normalize(value.replace(/^\.\//, ''));
	if (/\.ya?ml$/.test(target)) {
		return [target];
	}
	return [path.posix.join(target, 'action.yml'), path.posix.join(target, 'action.yaml')];
}

export function formatFinding(file: string, finding: Finding): string {
	return `${file}:${finding.line}: a test in a workflow file [${finding.rule}] — ${finding.evidence}\n  ${finding.remedy}`;
}
