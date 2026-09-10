import * as core from '@actions/core';
import {globSync} from 'node:fs';
import {readFileSync} from 'node:fs';
import {currentEvent, onTouchedLines, scopeOf} from './changed';
import {guard} from './guard';
import {capped, STE_MAX_WORDS} from './inputs';
import {DEFAULTS, failureReport, hasFailures, lintFiles, type Options} from './lint';
import {inSubmodule, submodulePaths} from './submodules';
import {vendoredPaths} from './vendored';

function gitmodules(): string {
	try {
		return readFileSync('.gitmodules', 'utf-8');
	} catch {
		return '';
	}
}

// A patterns input of "" would glob nothing and pass, which is the silent
// no-op this action exists to prevent, so an empty match is a failure.
function patternsOf(raw: string): string[] {
	return raw
		.split(/[\s,]+/)
		.map((p) => p.trim())
		.filter(Boolean);
}

function preview(items: string[], limit = 20): string {
	const shown = items.slice(0, limit).map(item => `\n  ${item}`).join('');
	return shown + (items.length > limit ? `\n  ... and ${items.length - limit} more` : '');
}

function main(): void {
	const gate = guard({
		workspace: process.env.GITHUB_WORKSPACE,
		workflowRef: process.env.GITHUB_WORKFLOW_REF,
		actionRef: process.env.GITHUB_ACTION_REF,
	});
	for (const note of gate.notes) core.info(note);
	// A check that did not happen is never a check that passed.
	for (const u of gate.unknown) core.error(`ste-lint could not establish ${u}`);
	if (gate.failure) {
		core.setFailed(gate.failure);
		return;
	}

	const patterns = patternsOf(core.getInput('files') || '**/*.md');
	const opts: Options = {
		hardMaxWords: capped('hard-max-words', core.getInput('hard-max-words'), DEFAULTS.hardMaxWords, STE_MAX_WORDS),
		warnMaxWords: capped('warn-max-words', core.getInput('warn-max-words'), DEFAULTS.warnMaxWords, STE_MAX_WORDS),
	};
	if (opts.warnMaxWords > opts.hardMaxWords) {
		throw new Error(`warn-max-words (${opts.warnMaxWords}) must not exceed hard-max-words (${opts.hardMaxWords})`);
	}

	const matched = [...new Set(patterns.flatMap((p) => globSync(p, {exclude: (n: string) => n.includes('node_modules')})))].sort();
	if (matched.length === 0) {
		core.setFailed(`ste-lint matched no files: ${patterns.join(' ')}. A check that reads nothing passes for the wrong reason.`);
		return;
	}
	const submodules = submodulePaths(gitmodules());
	const skip = inSubmodule(submodules);
	const ours = matched.filter((name) => !skip(name));
	if (submodules.length) core.info(`ste-lint: ${matched.length - ours.length} file(s) belong to a submodule: ${submodules.join(' ')}`);
	const vendored = vendoredPaths(ours);
	const theirs = ours.filter((name) => !vendored.has(name));
	if (vendored.size) core.info(`ste-lint: ${ours.length - theirs.length} file(s) are marked linguist-vendored or linguist-generated`);
	if (theirs.length === 0) {
		core.setFailed(
			`ste-lint read none of the ${matched.length} file(s) that ${patterns.join(' ')} matched: every one belongs to another repository. ` +
				'A check that reads nothing passes for the wrong reason.',
		);
		return;
	}

	// The scope is the line this event changed, not the file it sits in. A
	// sentence the change did not write is somebody else's finding, on somebody
	// else's commit.
	const scope = scopeOf(currentEvent());
	core.info(scope.note);
	const names = scope.touched === null ? theirs : theirs.filter((name) => scope.touched?.has(name));
	if (scope.touched !== null && names.length === 0) {
		core.info('ste-lint: this change touched none of them, so there is nothing to check');
		core.setOutput('files', 0);
		core.setOutput('violations', 0);
		return;
	}
	core.info(`ste-lint: ${names.length} file(s)`);

	const all = lintFiles(
		names.map((name) => ({name, text: readFileSync(name, 'utf-8')})),
		opts,
	);
	// A sentence is measured whole, over the lines it wraps across, so a finding
	// names where the writer must go. That is the line the scope asks about.
	const findings = scope.touched === null ? all : onTouchedLines(all, scope.touched);

	core.setOutput('files', names.length);
	core.setOutput(
		'violations',
		findings.hardLong.length +
			findings.contractions.length +
			findings.bannedModals.length +
			findings.semicolons.length +
			findings.commaSplices.length +
			findings.wrappedLines.length,
	);

	if (hasFailures(findings)) {
		core.setFailed(
			'STE-style lint failed -- mechanical subset only, NOT full ASD-STE100 conformance ' +
				'(several writing rules need real semantic judgment a pattern cannot do; ' +
				'see docs/ste-lint-spec-mapping.md):\n\n' +
				failureReport(findings, opts),
		);
	}

	// Heuristics warn and never fail. Each one has real false positives, and a
	// check people learn to ignore is worse than no check.
	if (findings.warnLong.length) {
		core.warning(
			`Sentences over ${opts.warnMaxWords} words, under the ${opts.hardMaxWords}-word hard cap ` +
				`(an instruction stays at or under ${opts.warnMaxWords}; a description may run to ${opts.hardMaxWords}) ` +
				`(${findings.warnLong.length} found): ${preview(findings.warnLong)}`,
		);
	}
	if (findings.passive.length) {
		core.warning(`Possible passive voice, heuristic only, not enforced (${findings.passive.length} lines): ${preview(findings.passive)}`);
	}
	if (findings.nounClusters.length) {
		core.warning(
			`Possible long noun cluster, heuristic only, not enforced (${findings.nounClusters.length} found): ${preview(findings.nounClusters)}`,
		);
	}
	if (findings.complexTense.length) {
		core.warning(
			`Possible complex verb tense (STE allows only simple tenses), heuristic only, not enforced ` +
				`(${findings.complexTense.length} found): ${preview(findings.complexTense)}`,
		);
	}
	if (findings.bannedWords.length) {
		core.warning(
			`Word not approved in the ASD-STE100 dictionary, heuristic only, not enforced -- this checker ` +
				`matches text, not part of speech or meaning, so it can miss a word's approved sense ` +
				`(${findings.bannedWords.length} found): ${preview(findings.bannedWords)}`,
		);
	}
	if (findings.longParagraphs.length) {
		core.warning(
			`Paragraph over 6 sentences, heuristic only, not enforced ` +
				`(${findings.longParagraphs.length} found): ${preview(findings.longParagraphs)}`,
		);
	}
}

// Local mode: `node dist/index.js '**/*.md'` lints the given patterns and
// prints what CI prints. A finding count is then a command anyone can run, not
// a number somebody remembers.
function cli(patterns: string[]): number {
	const opts: Options = {...DEFAULTS};
	const skip = inSubmodule(submodulePaths(gitmodules()));
	const ours = [...new Set(patterns.flatMap((p) => globSync(p, {exclude: (n: string) => n.includes('node_modules')})))].sort().filter((name) => !skip(name));
	const vendored = vendoredPaths(ours);
	const names = ours.filter((name) => !vendored.has(name));
	if (names.length === 0) {
		process.stderr.write(`ste-lint matched no files: ${patterns.join(' ')}\n`);
		return 2;
	}
	const findings = lintFiles(
		names.map((name) => ({name, text: readFileSync(name, 'utf-8')})),
		opts,
	);
	process.stdout.write(`ste-lint: ${names.length} file(s)\n`);
	for (const [label, list] of [
		['sentences over the cap', findings.hardLong],
		['contractions', findings.contractions],
		['banned modals', findings.bannedModals],
		['semicolons', findings.semicolons],
		['comma splices', findings.commaSplices],
		['hard-wrapped lines', findings.wrappedLines],
	] as const) {
		process.stdout.write(`${String(list.length).padStart(6)}  ${label}\n`);
	}
	if (!hasFailures(findings)) return 0;
	process.stderr.write('\n' + failureReport(findings, opts) + '\n');
	return 1;
}

const args = process.argv.slice(2);
if (args.length > 0) {
	process.exit(cli(args));
}

try {
	main();
} catch (err) {
	core.setFailed(err instanceof Error ? err.message : String(err));
}
