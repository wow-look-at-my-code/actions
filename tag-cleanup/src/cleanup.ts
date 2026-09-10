import * as core from '@actions/core';
import { exec } from '@actions/exec';
import { actionDirsFromPaths, classifyTag, TagContext } from './classify';

// One git call with captured output. A nonzero exit is always a hard error:
// a failed existence probe must never read as "nothing exists", or the sweep
// would delete every tag in the repository.
async function git(args: string[], cwd: string): Promise<string> {
	let stdout = '';
	let stderr = '';
	const code = await exec('git', args, {
		cwd,
		listeners: {
			stdout: (data) => (stdout += data.toString()),
			stderr: (data) => (stderr += data.toString()),
		},
		ignoreReturnCode: true,
	});
	if (code !== 0) {
		throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
	}
	return stdout;
}

function defaultBranchOf(symrefOutput: string): string {
	for (const line of symrefOutput.split('\n')) {
		const match = /^ref: refs\/heads\/(\S+)/.exec(line);
		if (match) return match[1];
	}
	throw new Error('could not resolve the default branch on origin');
}

export interface RunOptions {
	// Working directory of the checkout whose "origin" remote is swept
	cwd: string;
	dryRun: boolean;
	// Overrides GITHUB_REF_NAME and the git fallback; tests inject this
	currentBranch?: string;
}

export async function run(options: RunOptions): Promise<void> {
	const { cwd, dryRun } = options;

	const defaultBranch = defaultBranchOf(
		await git(['ls-remote', '--symref', 'origin', 'HEAD'], cwd),
	);
	core.info(`Default branch: ${defaultBranch}`);

	// Judge existence by the default branch, never by the checkout. A feature
	// branch that deletes an action must not delete that action's tags on its
	// own CI run, and only the default branch decides what still exists.
	await git(
		[
			'fetch',
			'--quiet',
			'--depth',
			'1',
			'--no-tags',
			'origin',
			`+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`,
		],
		cwd,
	);

	const treePaths = (
		await git(['ls-tree', '-r', '--name-only', `refs/remotes/origin/${defaultBranch}`], cwd)
	)
		.split('\n')
		.filter((path) => path.length > 0);
	const actionDirs = actionDirsFromPaths(treePaths);

	const branches = new Set(
		(await git(['ls-remote', '--heads', 'origin'], cwd))
			.split('\n')
			.filter((line) => line.includes('\t'))
			.map((line) => line.split('\t')[1])
			.map((ref) => ref.replace(/^refs\/heads\//, '')),
	);

	const currentBranch =
		options.currentBranch ??
		process.env.GITHUB_REF_NAME ??
		(await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd));

	// ls-remote is authoritative and needs no local tag fetch. The ^{} peel
	// lines duplicate their annotated tag, so they are dropped.
	const tags = (await git(['ls-remote', '--tags', 'origin'], cwd))
		.split('\n')
		.filter((line) => line.includes('\t'))
		.map((line) => line.split('\t')[1])
		.filter((ref) => ref.startsWith('refs/tags/') && !ref.endsWith('^{}'))
		.map((ref) => ref.replace(/^refs\/tags\//, ''));

	const ctx: TagContext = { actionDirs, branches, currentBranch, defaultBranch };

	const deletions: { tag: string; why: string }[] = [];
	let kept = 0;
	for (const tag of tags) {
		const verdict = classifyTag(tag, ctx);
		if (verdict.kind === 'keep') {
			kept++;
			core.debug(`Keeping tag '${tag}' (${verdict.why})`);
		} else {
			deletions.push({ tag, why: verdict.why });
		}
	}

	let deleted = 0;
	for (const { tag, why } of deletions) {
		if (dryRun) {
			core.info(`Would delete stale tag: ${tag} (${why})`);
			continue;
		}
		core.info(`Deleting stale tag: ${tag} (${why})`);
		// Only the ref-update race is tolerated. Two cleanup runs can target the
		// same tag, and the loser's push must not fail the job. Every other
		// push failure surfaces as a warning, never as silent success.
		const code = await exec('git', ['push', 'origin', '--delete', `refs/tags/${tag}`], {
			cwd,
			ignoreReturnCode: true,
		});
		if (code !== 0) {
			core.warning(`Could not delete ${tag}; it may already be gone`);
			continue;
		}
		deleted++;
	}

	core.setOutput('deleted-count', String(deleted));
	core.info(
		dryRun
			? `Kept ${kept} tags; ${deletions.length} stale tags found (dry run, nothing deleted)`
			: `Kept ${kept} tags; deleted ${deleted} of ${deletions.length} stale tags`,
	);

	// Job summaries exist only inside Actions; outside one there is nothing to
	// write to, and @actions/core throws asynchronously when the file is absent.
	if (deletions.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
		core.summary
			.addHeading(dryRun ? 'Stale tags (dry run)' : 'Deleted stale tags')
			.addTable([
				[{ data: 'Tag', header: true }, { data: 'Reason', header: true }],
				...deletions.map(({ tag, why }) => [tag, why]),
			])
			.write();
	}
}

