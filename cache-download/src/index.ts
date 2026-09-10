import * as core from '@actions/core';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
// Internal modules of the pinned @actions/cache (exact version in
// package.json; bundled into dist/ at release). These internals — not the
// public restoreCache() — are what let us send our own (key, version) pair:
// the twirp v2 cache service takes both as plain request parameters, and
// the path-derived version hash is purely client-side convention. Driving
// these endpoints directly with the job's ACTIONS_RUNTIME_TOKEN is
// established practice (docker buildx `--cache-from type=gha` and sccache's
// GHA backend speak to the same service).
//
// Known risk, deliberately accepted rather than mitigated: this protocol is
// undocumented and GitHub has changed it before — the legacy REST flavor
// was shut off in 2025 in favor of this twirp service. A bundled pin cannot
// protect against a server-side shutdown; when the protocol moves again,
// this action breaks LOUDLY (RPC errors → failed jobs, never silent
// corruption) until @actions/cache is bumped here and the action
// republished. The actual containment is the release model, not the pin:
// every consumer rides the moving `<name>#latest` tags, so the fix lands
// org-wide from this one repo without touching consumer workflows — unlike
// 2025, where every action pinning an old @actions/cache had to update
// independently. The pin/bundle itself just keeps releases hermetic and
// reviewable.
//
// Verified against @actions/cache 5.2.0 sources:
//   - internalCacheTwirpClient (lib/internal/shared/cacheTwirpClient.js:171,
//     auth via getRuntimeToken() = ACTIONS_RUNTIME_TOKEN at :34, base URL via
//     config.getCacheServiceURL() = ACTIONS_RESULTS_URL at :35) — both env
//     vars are injected by the runner into every job step; no workflow
//     `permissions:` needed (the cache does not use GITHUB_TOKEN).
//   - GetCacheEntryDownloadURL({key, restoreKeys, version}) ->
//     {ok, signedDownloadUrl, matchedKey}
//     (lib/generated/results/api/v1/cache.d.ts). !ok is a miss; the service
//     resolves the exact key first, then the restore keys by prefix — the
//     flow mirrors restoreCacheV2 in lib/cache.js.
//   - cacheHttpClient.downloadCache(signedDownloadUrl, archivePath,
//     {useAzureSdk: false, concurrentBlobDownloads: true}) routes Azure blob
//     URLs to downloadUtils.downloadCacheHttpClientConcurrent
//     (lib/internal/cacheHttpClient.js, downloadCache). These are upstream's
//     own defaults (lib/options.js), and the dispatcher comment there says
//     the concurrent HttpClient path exists "to work around blob SDK issue".
//     We pass them EXPLICITLY (not by omitting the argument) to document
//     that the Azure SDK path (downloadCacheStorageSDK) is deliberately
//     avoided: its response-stream teardown can reject with Node's
//     ERR_STREAM_PREMATURE_CLOSE after every byte has already arrived
//     ("Received ... (100.0%)" then "Premature close"), and nothing retries
//     it — downloadCache is called once, so the blip fails the whole job
//     (seen in prod 2026-07-19: github-state-mirror run 29669934747; the
//     rerun restored the same entry fine). The concurrent path downloads
//     4 MiB ranged segments each wrapped in downloadSegmentRetry (5 retries
//     + a 30s per-attempt timeout), which absorbs exactly this class of
//     transient stream failure.
//   - config.getCacheServiceVersion() (lib/internal/config.js:18-24) gates
//     v2 on the runner-set ACTIONS_CACHE_SERVICE_V2 flag and always reports
//     v1 on GHES; this action supports only the v2 service (github.com).
import * as cacheHttpClient from '@actions/cache/lib/internal/cacheHttpClient';
import {getCacheServiceVersion} from '@actions/cache/lib/internal/config';
import {internalCacheTwirpClient} from '@actions/cache/lib/internal/shared/cacheTwirpClient';
import {ambiguityMessage, distinctHandoffNames} from './discovery';
import {handoffKey, handoffRestorePrefix, handoffVersion, legacyHandoffKey, legacyHandoffRestorePrefix, legacyHandoffVersion, nameFromKey, runRestorePrefix, validateName} from '../../_shared/cache-xfer/lib';
import {MissOutcome, missOutcome, namelessMissOutcome} from './miss';
import {unpackFromFile} from '../../_shared/cache-xfer/xfer';

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return value;
}

function expandTilde(p: string): string {
	if (p === '~') {
		return os.homedir();
	}
	if (p.startsWith('~/')) {
		return path.join(os.homedir(), p.slice(2));
	}
	return p;
}

interface TwirpLookup {
	ok: boolean;
	signedDownloadUrl: string;
	matchedKey: string;
}

interface TwirpClient {
	GetCacheEntryDownloadURL(req: {key: string; restoreKeys: string[]; version: string}): Promise<TwirpLookup>;
}

/**
 * List this run's hand-off cache keys via the documented public REST API
 * (the endpoint cache-cleanup uses; the twirp client has no list RPC).
 * Plain fetch — no octokit dependency needed for one paginated GET.
 */
async function listRunCacheKeys(token: string, runPrefix: string): Promise<string[]> {
	const api = process.env.GITHUB_API_URL || 'https://api.github.com';
	const repo = requireEnv('GITHUB_REPOSITORY');
	const keys: string[] = [];
	for (let page = 1; page <= 10; page++) {
		const url = `${api}/repos/${repo}/actions/caches?key=${encodeURIComponent(runPrefix)}&per_page=100&page=${page}`;
		const resp = await fetch(url, {
			headers: {
				authorization: `Bearer ${token}`,
				accept: 'application/vnd.github+json',
				'x-github-api-version': '2022-11-28'
			}
		});
		if (!resp.ok) {
			throw new Error(`GET /actions/caches returned HTTP ${resp.status}`);
		}
		const body = (await resp.json()) as {actions_caches?: Array<{key?: string}>};
		const batch = (body.actions_caches ?? []).map(e => e.key).filter((k): k is string => typeof k === 'string');
		keys.push(...batch);
		if (batch.length < 100) {
			break;
		}
	}
	return keys;
}

/** What the lookup phase resolved (or failed to resolve). */
interface Resolution {
	lookup: TwirpLookup;
	/** The hand-off name, when known before download (named mode / listed discovery). */
	name?: string;
	/** TRANSITION: true when the pre-v2 legacy layout satisfied a named lookup. */
	legacy: boolean;
	miss: MissOutcome;
}

/** Named mode: exact v2 key, v2 prefix, then the TRANSITION legacy fallback. */
async function resolveNamed(twirpClient: TwirpClient, name: string, runId: string, runAttempt: string, failIfMissing: boolean): Promise<Resolution> {
	const key = handoffKey(name, runId, runAttempt);
	const restorePrefix = handoffRestorePrefix(name, runId);
	let lookup = await twirpClient.GetCacheEntryDownloadURL({key, restoreKeys: [restorePrefix], version: handoffVersion()});
	let legacy = false;
	if (!lookup.ok) {
		// TRANSITION fallback (remove after the v2 rollout): a producer still
		// on the pre-v2 cache-upload saved under the name-first layout and the
		// v1 version. #latest tags move on merge, so a new consumer can race
		// an old producer mid-rollout; this keeps that window unbroken.
		lookup = await twirpClient.GetCacheEntryDownloadURL({
			key: legacyHandoffKey(name, runId, runAttempt),
			restoreKeys: [legacyHandoffRestorePrefix(name, runId)],
			version: legacyHandoffVersion()
		});
		legacy = lookup.ok;
		if (legacy) {
			core.warning(`Hand-off '${name}' was found under the pre-v2 legacy key layout (${lookup.matchedKey}); the producing job ran an older cache-upload. This fallback exists only for the rollout and will be removed.`);
		}
	}
	return {lookup, name, legacy, miss: missOutcome(name, key, restorePrefix, failIfMissing)};
}

/**
 * Nameless mode: discover this run's single hand-off by the run-scoped
 * prefix. The REST listing (best-effort — it needs a github-token with
 * `actions: read`, which the twirp runtime token is not) is the ambiguity
 * guard: two or more distinct names in this run is a HARD error naming the
 * candidates, never a silent pick. When listing is unavailable the newest
 * run-scoped entry is restored and a warning says the check was skipped.
 * There is deliberately NO legacy-layout fallback here: a nameless
 * old-layout prefix search is exactly the cross-run bug v2 fixed.
 */
async function resolveNameless(twirpClient: TwirpClient, runId: string, runAttempt: string, failIfMissing: boolean): Promise<Resolution | 'ambiguous'> {
	const runPrefix = runRestorePrefix(runId);
	let discovered: string | undefined;
	const token = core.getInput('github-token');
	if (token) {
		try {
			const names = distinctHandoffNames(await listRunCacheKeys(token, runPrefix), runId);
			if (names.length > 1) {
				core.setFailed(ambiguityMessage(names));
				return 'ambiguous';
			}
			discovered = names[0];
		} catch (error) {
			core.warning(`Could not list this run's hand-offs to check for ambiguity (${error instanceof Error ? error.message : String(error)}). Restoring the newest run-scoped entry; runs with multiple hand-offs should pass an explicit 'name'.`);
		}
	} else {
		core.warning("No github-token available for the ambiguity check. Restoring the newest run-scoped entry; runs with multiple hand-offs should pass an explicit 'name'.");
	}

	// With a discovered name the request mirrors named mode (exact key for
	// this attempt, then the name-scoped prefix); without one the bare
	// run-scoped prefix restores the newest entry of this run.
	const request = discovered === undefined
		? {key: runPrefix, restoreKeys: [runPrefix], version: handoffVersion()}
		: {key: handoffKey(discovered, runId, runAttempt), restoreKeys: [handoffRestorePrefix(discovered, runId)], version: handoffVersion()};
	const lookup = await twirpClient.GetCacheEntryDownloadURL(request);
	return {lookup, name: discovered, legacy: false, miss: namelessMissOutcome(runPrefix, failIfMissing)};
}

async function run(): Promise<void> {
	const serviceVersion = getCacheServiceVersion();
	if (serviceVersion !== 'v2') {
		throw new Error(`cache-download requires the v2 cache service (github.com); this runner reports '${serviceVersion}'. GHES is not supported.`);
	}

	const nameInput = core.getInput('name');
	const pathInput = core.getInput('path');
	const failIfMissing = core.getBooleanInput('fail-if-missing');
	if (nameInput) {
		validateName(nameInput);
	}

	// Artifact parity: the destination is a real directory of the consumer's
	// choosing, defaulting to the workspace. Nothing about it needs to match
	// what the producer passed to cache-upload.
	const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
	const destination = path.resolve(workspace, expandTilde(pathInput || '.'));

	const runId = requireEnv('GITHUB_RUN_ID');
	const runAttempt = process.env.GITHUB_RUN_ATTEMPT || '1';

	const twirpClient = internalCacheTwirpClient();
	const resolved = nameInput
		? await resolveNamed(twirpClient, nameInput, runId, runAttempt, failIfMissing)
		: await resolveNameless(twirpClient, runId, runAttempt, failIfMissing);
	if (resolved === 'ambiguous') {
		return;
	}

	if (!resolved.lookup.ok) {
		core.setOutput('cache-hit', 'false');
		core.setOutput('cache-matched-key', '');
		core.setOutput('download-path', '');
		core.setOutput('name', '');
		if (resolved.miss.fail) {
			core.setFailed(resolved.miss.message);
		} else {
			core.info(resolved.miss.message);
		}
		return;
	}

	const matchedKey = resolved.lookup.matchedKey;
	if (resolved.name) {
		core.info(`Hand-off '${resolved.name}' matched key ${matchedKey}`);
	}

	const tempDir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cache-xfer-'));
	const archivePath = path.join(tempDir, 'handoff.wxfr');
	let resolvedName: string;
	try {
		// Explicitly upstream's own defaults, NOT the Azure SDK path — see the
		// downloadCache note in the header comment for why.
		await cacheHttpClient.downloadCache(resolved.lookup.signedDownloadUrl, archivePath, {useAzureSdk: false, concurrentBlobDownloads: true});
		const header = await unpackFromFile(archivePath, destination);
		// The envelope is the authority on the name (v1 archives, reachable
		// only via the named legacy fallback, predate the field).
		resolvedName = header.name ?? resolved.name ?? nameFromKey(matchedKey, runId) ?? '';
		core.info(`Restored hand-off '${resolvedName}' (${header.mode}) into ${destination}`);
	} finally {
		await fsp.rm(tempDir, {recursive: true, force: true});
	}

	if (!nameInput) {
		core.notice(`cache-download picked hand-off '${resolvedName}' for this run (key ${matchedKey})`);
	}

	// Exact hit = this attempt's own key (either layout during the
	// TRANSITION); a prefix match means an earlier attempt's entry.
	const exactHit = resolvedName !== '' && (matchedKey === handoffKey(resolvedName, runId, runAttempt) || matchedKey === legacyHandoffKey(resolvedName, runId, runAttempt));
	if (!exactHit) {
		core.info('Matched an earlier attempt of this run');
	}
	core.setOutput('cache-hit', String(exactHit));
	core.setOutput('cache-matched-key', matchedKey);
	core.setOutput('download-path', destination);
	core.setOutput('name', resolvedName);
}

run().catch((error: unknown) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
