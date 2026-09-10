import * as core from '@actions/core';
import * as fsp from 'fs/promises';
import * as path from 'path';
import {candidatePaths, findFindings, findRunBlocks, findUses, formatFinding, isLocalRef} from './scan';

// Tests belong in the repository's own suite, never in a workflow. see README.md

const SKIP_DIRS = new Set(['node_modules', '.git']);

function splitList(value: string): string[] {
	return value
		.split(/[\n,]/)
		.map(entry => entry.trim())
		.filter(entry => entry !== '');
}

// Glob to regex: `**` crosses directory separators, `*` and `?` do not.
function globToRegExp(glob: string): RegExp {
	let pattern = '';
	for (let index = 0; index < glob.length; index++) {
		const char = glob[index];
		if (char === '*') {
			if (glob[index + 1] === '*') {
				index++;
				if (glob[index + 1] === '/') {
					index++;
					pattern += '(?:.*/)?';
					continue;
				}
				pattern += '.*';
				continue;
			}
			pattern += '[^/]*';
			continue;
		}
		if (char === '?') {
			pattern += '[^/]';
			continue;
		}
		pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${pattern}$`);
}

async function walk(root: string, relative: string, found: string[]): Promise<void> {
	const entries = await fsp.readdir(path.join(root, relative), {withFileTypes: true});
	for (const entry of entries) {
		const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) {
				continue;
			}
			await walk(root, child, found);
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const isWorkflow = /^\.github\/workflows\/[^/]+\.ya?ml$/.test(child);
		const isAction = /(^|\/)action\.ya?ml$/.test(child);
		if (isWorkflow || isAction) {
			found.push(child);
		}
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await fsp.stat(file);
		return true;
	} catch {
		return false;
	}
}

async function readIfPresent(file: string): Promise<string | undefined> {
	try {
		return await fsp.readFile(file, 'utf8');
	} catch (error) {
		if ((error as {code?: string}).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

async function run(): Promise<void> {
	const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
	const excludes = splitList(core.getInput('exclude')).map(globToRegExp);
	const isExcluded = (file: string): boolean => excludes.some(pattern => pattern.test(file));

	const explicitRoots = splitList(core.getInput('paths'));
	const roots: string[] = [];
	if (explicitRoots.length > 0) {
		roots.push(...explicitRoots.map(entry => path.posix.normalize(entry.replace(/^\.\//, ''))));
	} else {
		await walk(workspace, '', roots);
		roots.sort();
	}

	const queue = roots.filter(file => !isExcluded(file));
	const seen = new Set(queue);
	const scanned: string[] = [];
	const remoteRefs = new Set<string>();
	const messages: string[] = [];
	const chainErrors: string[] = [];

	while (queue.length > 0) {
		const file = queue.shift() as string;
		const content = await readIfPresent(path.join(workspace, file));
		if (content === undefined) {
			chainErrors.push(`${file}: no such file in the workspace — the paths input names a file that is not here`);
			continue;
		}
		scanned.push(file);

		for (const block of findRunBlocks(content)) {
			for (const finding of findFindings(block)) {
				messages.push(formatFinding(file, finding));
			}
		}

		for (const ref of findUses(content)) {
			if (!isLocalRef(ref.value)) {
				remoteRefs.add(ref.value);
				continue;
			}
			const candidates = candidatePaths(ref.value);
			let resolved: string | undefined;
			for (const candidate of candidates) {
				if (await exists(path.join(workspace, candidate))) {
					resolved = candidate;
					break;
				}
			}
			if (resolved === undefined) {
				chainErrors.push(`${file}:${ref.line}: \`uses: ${ref.value}\` resolves to none of ${candidates.join(', ')} — the call chain cannot be followed past it`);
				continue;
			}
			if (isExcluded(resolved) || seen.has(resolved)) {
				continue;
			}
			seen.add(resolved);
			queue.push(resolved);
		}
	}

	for (const ref of [...remoteRefs].sort()) {
		core.info(`not followed (another repository): ${ref}`);
	}

	if (messages.length === 0 && chainErrors.length === 0) {
		if (scanned.length === 0) {
			// The check enforced nothing. Say so: a repo that runs this action
			// has at least one workflow file, so an empty scan means the
			// workspace is not the repo (usually a missing checkout).
			core.warning(`nothing to scan under ${workspace} — no workflow file and no action.yml, so this run enforced nothing. Check the repo out first.`);
			return;
		}
		core.info(`OK — no test found in ${scanned.length} file(s): ${scanned.join(', ')}`);
		return;
	}
	for (const message of [...messages, ...chainErrors]) {
		core.error(message);
	}
	if (messages.length > 0) {
		core.setFailed(`${messages.length} test(s) live in a workflow file, across ${scanned.length} scanned file(s). A workflow step schedules work; it is not a test harness.`);
		return;
	}
	core.setFailed(`${chainErrors.length} part(s) of the call chain could not be read, so they went unscanned`);
}

run().catch((error: unknown) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
