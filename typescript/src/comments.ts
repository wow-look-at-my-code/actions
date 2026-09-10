import * as ts from 'typescript';

/** A run of consecutive comment-only lines. Both bounds are 1-based, inclusive. */
export interface CommentBlock {
	startLine: number;
	endLine: number;
}

/** Start offset of every line in `text` (index 0 = line 1). */
function lineStarts(text: string): number[] {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/** 0-based index into `starts` of the line containing `pos`. */
function lineOf(starts: number[], pos: number): number {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= pos) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/**
 * 1-based lines holding nothing but a `//` comment. Found with the TypeScript
 * scanner, so `//` inside a string, template literal or regex is not one.
 */
function commentOnlyLines(script: string): number[] {
	const starts = lineStarts(script);
	const scanner = ts.createScanner(ts.ScriptTarget.Latest, /* skipTrivia */ false, ts.LanguageVariant.Standard, script);
	const lines: number[] = [];
	for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
		if (kind !== ts.SyntaxKind.SingleLineCommentTrivia) continue;
		const start = scanner.getTokenStart();
		const line = lineOf(starts, start);
		if (script.slice(starts[line], start).trim() !== '') continue;
		lines.push(line + 1);
	}
	return lines;
}

/**
 * Runs of two or more consecutive `//`-only lines — the shape a paragraph of
 * prose takes once it is pasted into a script.
 */
export function findCommentBlocks(script: string): CommentBlock[] {
	const lines = commentOnlyLines(script);
	const blocks: CommentBlock[] = [];
	for (let i = 0; i < lines.length; ) {
		let j = i;
		while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
		if (j > i) blocks.push({ startLine: lines[i], endLine: lines[j] });
		i = j + 1;
	}
	return blocks;
}
