// Prose from another repository is that repository's to lint. submodules.ts
// already acts on that for a submodule, which is the case where git holds the
// other repository by reference. This file covers the case where git holds a
// copy: vendored code, and the imported tree of a fork.
//
// The source is `git check-attr`, so the declaration is `.gitattributes`:
//
//     src/vendor/**   linguist-vendored
//
// That is not an ignore list. `linguist-vendored` and `linguist-generated` are
// git attributes a repository sets to state where its code comes from, GitHub
// reads them for the language bar and the diff view, and they carry the same
// meaning with this action absent. A caller cannot answer a finding by adding a
// line here: marking a file vendored is a claim about who wrote it, and it
// changes what the repository reports about itself everywhere else too.
//
// A repository that writes its own prose declares nothing and loses nothing.

import {execFileSync} from 'node:child_process';

const ATTRIBUTES = ['linguist-vendored', 'linguist-generated'];

// Reports which of the named files git marks as another party's code. It asks
// git once, over stdin, because a call per file costs a process per file.
//
// A failure here returns the empty set, so a checkout without git, or a path
// git does not know, lints normally: this decides what to SKIP, and a check
// that skips on an error is a check that passes for the wrong reason.
export function vendoredPaths(files: string[], run = gitCheckAttr): Set<string> {
	const vendored = new Set<string>();
	if (files.length === 0) return vendored;
	for (const attribute of ATTRIBUTES) {
		let out: string;
		try {
			out = run(attribute, files);
		} catch {
			continue;
		}
		for (const line of out.split('\0')) {
			// `git check-attr -z` writes NUL-separated triples: path, attribute, value.
			// Splitting on NUL alone gives a flat list, so read it three at a time.
			const parts = line;
			if (parts === '') continue;
			vendored.add(parts);
		}
	}
	return vendored;
}

function gitCheckAttr(attribute: string, files: string[]): string {
	const out = execFileSync('git', ['check-attr', '--stdin', '-z', attribute], {
		input: files.join('\0'),
		encoding: 'utf-8',
	});
	return setPaths(out);
}

// Turns `git check-attr -z` output into a NUL-separated list of the paths whose
// value is "set". The output is a flat NUL-separated stream of triples, so the
// value of a triple is every third field.
export function setPaths(out: string): string {
	const fields = out.split('\0');
	const hits: string[] = [];
	for (let i = 0; i + 2 < fields.length; i += 3) {
		if (fields[i + 2] === 'set') hits.push(fields[i]);
	}
	return hits.join('\0');
}
