// Download-only module: turns the `name` and `path` inputs into the list of
// hand-offs to restore and where each one lands.

/** One hand-off to restore. */
export interface DownloadPlan {
	name: string;
	/** Destination directory, relative to the workspace unless absolute. */
	destination: string;
}

/** Split a multi-line input into its non-empty trimmed lines. */
export function inputLines(input: string): string[] {
	return input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/**
 * One name restores into `path` (the workspace when empty). Several names
 * take either one `path`, under which each lands in its own `<path>/<name>`
 * directory, or one path per name, in order. Any other count is an error:
 * a partial pairing would restore some hand-offs into a guessed place.
 */
export function planDownloads(names: string[], paths: string[]): DownloadPlan[] {
	if (names.length <= 1) {
		if (paths.length > 1) {
			throw new Error(`'path' lists ${paths.length} directories for ${names.length === 0 ? 'nameless discovery' : 'one hand-off'}; give one`);
		}
		return names.map(name => ({name, destination: paths[0] ?? '.'}));
	}
	if (paths.length <= 1) {
		const root = paths[0] ?? '.';
		return names.map(name => ({name, destination: `${root}/${name}`}));
	}
	if (paths.length !== names.length) {
		throw new Error(`'name' lists ${names.length} hand-offs but 'path' lists ${paths.length} directories; give one path, or one per name`);
	}
	return names.map((name, i) => ({name, destination: paths[i]}));
}
