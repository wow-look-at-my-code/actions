import { createLowlight } from 'lowlight';
import typescript from 'highlight.js/lib/languages/typescript';
import type { Element, ElementContent, RootContent } from 'hast';

// Syntax highlighting for the workflow log via raw 24-bit ANSI escapes
// (`\x1b[38;2;R;G;Bm`), which GitHub's Actions log viewer renders. The escapes
// are emitted unconditionally: the log is a pipe, not a TTY, so any
// supports-color style autodetection (chalk & co.) would strip every color.

/** 24-bit foreground SGR sequence for a `#rrggbb` color. */
function fg(hex: string): string {
	const n = parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(n >> 16) & 0xff};${(n >> 8) & 0xff};${n & 0xff}m`;
}

/** Reset the foreground color to the log default (other attributes untouched). */
const FG_DEFAULT = '\x1b[39m';

/** Sentinel for "explicitly uncolored" — resets to default instead of inheriting. */
const PLAIN = '';

// highlight.js scope → color, GitHub-dark friendly (Primer's dark syntax hues,
// readable on the Actions log's dark background). Lookup walks dotted scopes
// from most to least specific ('title.class.inherited' falls back to
// 'title.class'); scopes not in the table inherit their enclosing color.
const PALETTE = new Map<string, string>([
	['keyword', fg('#ff7b72')], // const, await, if, class
	['variable.language', fg('#ff7b72')], // this, super, globalThis
	['string', fg('#a5d6ff')],
	['regexp', fg('#a5d6ff')],
	['comment', fg('#8b949e')],
	['number', fg('#79c0ff')],
	['literal', fg('#79c0ff')], // true, false, null, undefined, NaN
	['variable.constant', fg('#79c0ff')], // SCREAMING_CASE identifiers
	['title.function', fg('#d2a8ff')], // function declarations and calls
	['title.class', fg('#ffa657')],
	['type', fg('#ffa657')],
	['built_in', fg('#ffa657')], // built-in types (string, number) and globals (console, Math)
	['subst', PLAIN], // a template literal's ${...} is code, not string text
]);

const lowlight = createLowlight({ typescript });

/**
 * Reconstruct the dotted highlight.js scope from a hast element's classes —
 * lowlight emits scope `title.function` as `className: ['hljs-title', 'function_']`
 * (first part prefixed, sub-scope parts underscore-suffixed).
 */
function scopeOf(node: Element): string {
	const className = node.properties.className;
	const classes = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? [className] : [];
	if (classes.length === 0 || !classes[0].startsWith('hljs-')) return '';
	return classes.map((c, i) => (i === 0 ? c.slice('hljs-'.length) : c.replace(/_+$/, ''))).join('.');
}

function colorFor(scope: string): string | undefined {
	let s = scope;
	while (s !== '') {
		const color = PALETTE.get(s);
		if (color !== undefined) return color;
		const dot = s.lastIndexOf('.');
		if (dot === -1) return undefined;
		s = s.slice(0, dot);
	}
	return undefined;
}

/**
 * Append `value` wrapped in `color`. Every physical line is kept
 * self-contained — a multi-line token (block comment, template literal) closes
 * its color before each newline and re-opens it after — so the rendering also
 * survives viewers that reset SGR state at line boundaries.
 */
function emitText(value: string, color: string, out: string[]): void {
	if (color === PLAIN) {
		out.push(value);
		return;
	}
	const lines = value.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (i > 0) out.push('\n');
		const line = lines[i];
		const body = line.endsWith('\r') ? line.slice(0, -1) : line;
		if (body !== '') out.push(color, body, FG_DEFAULT);
		if (body !== line) out.push('\r');
	}
}

function render(nodes: ReadonlyArray<RootContent | ElementContent>, color: string, out: string[]): void {
	for (const node of nodes) {
		if (node.type === 'text') {
			emitText(node.value, color, out);
		} else if (node.type === 'element') {
			// An unmapped scope inherits the enclosing color (a doctag inside a
			// comment stays comment-gray); 'subst' maps to PLAIN explicitly.
			render(node.children, colorFor(scopeOf(node)) ?? color, out);
		}
		// lowlight trees contain only text and span elements; nothing else
		// carries source text.
	}
}

/**
 * Syntax-highlight `source` with raw ANSI color escapes for the workflow log.
 * Never throws: on any failure (unknown language, tokenizer error) the plain
 * source is returned — colorization must never fail the action.
 */
export function highlightSource(source: string, language = 'typescript'): string {
	try {
		const out: string[] = [];
		render(lowlight.highlight(language, source).children, PLAIN, out);
		return out.join('');
	} catch {
		return source;
	}
}
