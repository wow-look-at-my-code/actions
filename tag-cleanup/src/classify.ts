// Pure classification of orphan-release tags. A tag is junk when the thing it
// names is gone: the action directory on the default branch, the branch on the
// remote, or a sane version suffix.

export interface TagContext {
	// Directories on the default branch that carry an action.yml
	actionDirs: ReadonlySet<string>;
	// Branches that exist on the remote
	branches: ReadonlySet<string>;
	// The branch this run is on; its tags are never swept
	currentBranch: string;
	// Named in deletion reasons
	defaultBranch: string;
}

export type Verdict = { kind: 'keep'; why: string } | { kind: 'delete'; why: string };

export interface ParsedTag {
	tag: string;
	name: string;
	version: string;
}

// Strip the ref prefix and peel suffix, then split at the LAST '#'. Returns
// null for tags without '#': orphan-release never mints those, and a manually
// created tag may mean anything, so it must not be guessed at.
export function parseTag(ref: string): ParsedTag | null {
	const tag = ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, '');
	const hash = tag.lastIndexOf('#');
	if (hash === -1) return null;
	return { tag, name: tag.slice(0, hash), version: tag.slice(hash + 1) };
}

// Reduce `git ls-tree -r --name-only` output to action directories. A
// repo-root action.yml resolves to '', which would make every tag name an
// action, so it is not a directory a release tag can name.
export function actionDirsFromPaths(paths: string[]): Set<string> {
	const dirs = new Set<string>();
	for (const path of paths) {
		if (path === 'action.yml') continue;
		if (!path.endsWith('/action.yml')) continue;
		dirs.add(path.slice(0, -'/action.yml'.length));
	}
	return dirs;
}

function isSaneVersion(version: string): boolean {
	return version === 'latest' || /^[0-9]+$/.test(version);
}

// Walk ancestors-or-self of the name and return the first directory that is an
// action, so an "action/branch#1" branch tag resolves to its action root. The
// walk goes from the full name upward, which matches how orphan-release names
// branch tags: the action root is the shortest prefix, the branch is the rest.
function actionRoot(name: string, actionDirs: ReadonlySet<string>): string | null {
	const parts = name.split('/');
	for (let end = parts.length; end >= 1; end--) {
		const candidate = parts.slice(0, end).join('/');
		if (actionDirs.has(candidate)) return candidate;
	}
	return null;
}

export function classifyTag(ref: string, ctx: TagContext): Verdict {
	const parsed = parseTag(ref);
	if (!parsed) {
		return { kind: 'keep', why: 'no #, not a release tag' };
	}
	const { name, version } = parsed;

	if (!isSaneVersion(version)) {
		return { kind: 'delete', why: `version '${version}' is neither a number nor latest` };
	}

	const root = actionRoot(name, ctx.actionDirs);
	if (root === null) {
		return { kind: 'delete', why: `no directory '${name}' exists on ${ctx.defaultBranch}` };
	}
	if (root === name) {
		return { kind: 'keep', why: `action '${root}' exists on ${ctx.defaultBranch}` };
	}

	const branch = name.slice(root.length + 1);
	if (branch === ctx.currentBranch) {
		return { kind: 'keep', why: `branch '${branch}' is the current branch` };
	}
	if (ctx.branches.has(branch)) {
		return { kind: 'keep', why: `branch '${branch}' exists` };
	}
	return { kind: 'delete', why: `branch '${branch}' no longer exists` };
}
