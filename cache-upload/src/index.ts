import * as core from '@actions/core';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
// Internal modules of the pinned @actions/cache (exact version in
// package.json; bundled into dist/ at release). These internals — not the
// public saveCache() — are what let us send our own (key, version) pair:
// the twirp v2 cache service takes both as plain request parameters, and
// the path-derived version hash is purely client-side convention. Driving
// these endpoints directly with the job's ACTIONS_RUNTIME_TOKEN is
// established practice (docker buildx `--cache-to type=gha` and sccache's
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
//   - CreateCacheEntry({key, version}) -> {ok, signedUploadUrl, message},
//     FinalizeCacheEntryUpload({key, version, sizeBytes}) -> {ok, entryId}
//     (lib/generated/results/api/v1/cache.d.ts; flow mirrors saveCacheV2 in
//     lib/cache.js).
//   - cacheHttpClient.saveCache(cacheId, archivePath, signedUploadURL,
//     {useAzureSdk: true, ...}) routes to uploadUtils.uploadCacheArchiveSDK
//     (Azure blob PUT of the archive; lib/internal/cacheHttpClient.js,
//     saveCache) — cacheId is unused on that path.
//   - config.getCacheServiceVersion() (lib/internal/config.js:18-24) gates
//     v2 on the runner-set ACTIONS_CACHE_SERVICE_V2 flag and always reports
//     v1 on GHES; this action supports only the v2 service (github.com).
import * as cacheHttpClient from '@actions/cache/lib/internal/cacheHttpClient';
import {getCacheServiceVersion} from '@actions/cache/lib/internal/config';
import {internalCacheTwirpClient} from '@actions/cache/lib/internal/shared/cacheTwirpClient';
import {handoffKey, handoffVersion, validateName} from '../../_shared/cache-xfer/lib';
import {packToFile} from '../../_shared/cache-xfer/xfer';

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

async function run(): Promise<void> {
	const serviceVersion = getCacheServiceVersion();
	if (serviceVersion !== 'v2') {
		throw new Error(`cache-upload requires the v2 cache service (github.com); this runner reports '${serviceVersion}'. GHES is not supported.`);
	}

	const name = core.getInput('name', {required: true});
	const pathInput = core.getInput('path', {required: true});
	validateName(name);

	const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
	const source = path.resolve(workspace, expandTilde(pathInput));

	const key = handoffKey(name, requireEnv('GITHUB_RUN_ID'), process.env.GITHUB_RUN_ATTEMPT || '1');
	const version = handoffVersion();

	const tempDir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'cache-xfer-'));
	const archivePath = path.join(tempDir, 'handoff.wxfr');
	try {
		const header = await packToFile(source, archivePath, name);
		const archiveSize = (await fsp.stat(archivePath)).size;
		core.info(`Packed '${source}' (${header.mode}) into ${archiveSize} byte archive`);

		const twirpClient = internalCacheTwirpClient();
		core.info(`Saving hand-off '${name}' with key ${key}`);
		const reservation = await twirpClient.CreateCacheEntry({key, version});
		if (!reservation.ok) {
			// A same-(name,attempt) collision or a read-only cache policy both
			// land here; the service's message says which.
			throw new Error(`Unable to reserve cache entry for key ${key}${reservation.message ? `: ${reservation.message}` : ''}`);
		}

		await cacheHttpClient.saveCache(-1, archivePath, reservation.signedUploadUrl, {
			useAzureSdk: true,
			uploadChunkSize: 64 * 1024 * 1024,
			uploadConcurrency: 8,
			archiveSizeBytes: archiveSize
		});

		const finalized = await twirpClient.FinalizeCacheEntryUpload({key, version, sizeBytes: `${archiveSize}`});
		if (!finalized.ok) {
			throw new Error(`Unable to finalize cache entry for key ${key}${finalized.message ? `: ${finalized.message}` : ''}`);
		}
		core.info(`Hand-off '${name}' saved (entry ${finalized.entryId}, ${Math.round(archiveSize / (1024 * 1024))} MB)`);
		core.setOutput('key', key);
	} finally {
		await fsp.rm(tempDir, {recursive: true, force: true});
	}
}

run().catch((error: unknown) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
