// A submodule is another repository, checked out inside this one. Its prose is
// that repository's to lint, and its own CI is where a finding must appear. So
// this action reads .gitmodules itself and drops the paths it names. There is
// no input here on purpose: a list a caller writes is a list that grows by one
// entry every time the check finds something.

// A .gitmodules entry looks like:
//   [submodule "vendor/thing"]
//   \tpath = vendor/thing
// The path key is the one that decides where the submodule sits.
export function submodulePaths(text: string): string[] {
	const paths: string[] = [];
	for (const line of text.split('\n')) {
		const match = /^\s*path\s*=\s*(.+?)\s*$/.exec(line);
		if (!match) continue;
		const path = match[1].replace(/\/+$/, '');
		if (path !== '') paths.push(path);
	}
	return [...new Set(paths)].sort();
}

// Reports whether a file sits inside one of the paths. The path itself is a
// directory, so only a file under it counts: "vendor" never swallows
// "vendor-docs/README.md".
export function inSubmodule(paths: string[]): (file: string) => boolean {
	const prefixes = paths.map((path) => `${path}/`);
	return (file) => {
		const name = file.replace(/^\.\//, '');
		return prefixes.some((prefix) => name.startsWith(prefix));
	};
}
