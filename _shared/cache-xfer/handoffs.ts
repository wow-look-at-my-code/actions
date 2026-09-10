// The `save` and `restore` inputs: one YAML mapping, hand-off name to path.
// The caller parses the YAML; this module checks the shape and names every
// defect, so a typo in a workflow fails the step rather than handing off
// the wrong thing.

/** One hand-off to save: its name and the workspace paths it carries. */
export interface SaveEntry {
	name: string;
	paths: string[];
}

/** One hand-off to restore: its name and the directory it lands in. */
export interface RestoreEntry {
	name: string;
	destination: string;
}

function mappingEntries(doc: unknown, input: string): Array<[string, unknown]> {
	if (doc === null || doc === undefined) {
		throw new Error(`'${input}' is empty; give a mapping of hand-off name to path`);
	}
	if (typeof doc !== 'object' || Array.isArray(doc)) {
		throw new Error(`'${input}' must be a YAML mapping of hand-off name to path, got ${Array.isArray(doc) ? 'a list' : typeof doc}`);
	}
	const entries = Object.entries(doc as Record<string, unknown>);
	if (entries.length === 0) {
		throw new Error(`'${input}' names no hand-off`);
	}
	return entries;
}

function pathString(value: unknown, input: string, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`'${input}': hand-off '${name}' needs a path, got ${JSON.stringify(value)}`);
	}
	return value.trim();
}

/**
 * `save`: each value is one path, or a list of paths. A multi-line block
 * scalar is a list too, one path per line, so a plain workflow needs no
 * YAML list syntax.
 */
export function saveEntries(doc: unknown, input = 'save'): SaveEntry[] {
	return mappingEntries(doc, input).map(([name, value]) => {
		if (Array.isArray(value)) {
			if (value.length === 0) {
				throw new Error(`'${input}': hand-off '${name}' lists no path`);
			}
			return {name, paths: value.map(v => pathString(v, input, name))};
		}
		const paths = pathString(value, input, name).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
		return {name, paths};
	});
}

/** `restore`: each value is the directory that hand-off is restored into. */
export function restoreEntries(doc: unknown, input = 'restore'): RestoreEntry[] {
	return mappingEntries(doc, input).map(([name, value]) => {
		const destination = pathString(value, input, name);
		if (destination.includes('\n')) {
			throw new Error(`'${input}': hand-off '${name}' restores into one directory, got several lines`);
		}
		return {name, destination};
	});
}
