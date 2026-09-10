import * as core from '@actions/core';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as cacheHttpClient from '@actions/cache/lib/internal/cacheHttpClient';
import {getCacheServiceVersion} from '@actions/cache/lib/internal/config';
import {internalCacheTwirpClient} from '@actions/cache/lib/internal/shared/cacheTwirpClient';
import {CLAIM_PAYLOAD, ClaimService, claimKey, claimRun, claimVersion, validateName} from '../../_shared/run-claim/claim';

interface TwirpClient {
	CreateCacheEntry(req: {key: string; version: string}): Promise<{ok: boolean; signedUploadUrl: string; message?: string}>;
	FinalizeCacheEntryUpload(req: {key: string; version: string; sizeBytes: string}): Promise<{ok: boolean; entryId?: string; message?: string}>;
	GetCacheEntryDownloadURL(req: {key: string; restoreKeys: string[]; version: string}): Promise<{ok: boolean; signedDownloadUrl: string; matchedKey: string}>;
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Required environment variable ${name} is not set`);
	}
	return value;
}

function cacheService(twirpClient: TwirpClient, tempDir: string): ClaimService {
	return {
		create: async (key, version) => {
			const reservation = await twirpClient.CreateCacheEntry({key, version});
			return {ok: reservation.ok, message: reservation.message, signedUploadUrl: reservation.signedUploadUrl};
		},
		upload: async signedUploadUrl => {
			const claimFile = path.join(tempDir, 'claim');
			await fsp.writeFile(claimFile, CLAIM_PAYLOAD);
			const sizeBytes = (await fsp.stat(claimFile)).size;
			await cacheHttpClient.saveCache(-1, claimFile, signedUploadUrl, {
				useAzureSdk: true,
				uploadChunkSize: 64 * 1024 * 1024,
				uploadConcurrency: 1,
				archiveSizeBytes: sizeBytes
			});
			return sizeBytes;
		},
		finalize: async (key, version, sizeBytes) => {
			const finalized = await twirpClient.FinalizeCacheEntryUpload({key, version, sizeBytes: `${sizeBytes}`});
			return {ok: finalized.ok, message: finalized.message};
		},
		exists: async (key, version) => {
			const lookup = await twirpClient.GetCacheEntryDownloadURL({key, restoreKeys: [], version});
			return lookup.ok;
		}
	};
}

async function run(): Promise<void> {
	const name = core.getInput('name', {required: true});
	validateName(name);

	const key = claimKey(name, requireEnv('GITHUB_RUN_ID'), requireEnv('GITHUB_RUN_ATTEMPT'));
	core.setOutput('key', key);

	const serviceVersion = getCacheServiceVersion();
	if (serviceVersion !== 'v2') {
		core.warning(`run-once needs the v2 cache service to hold a claim; this runner reports '${serviceVersion}'. This job runs the work.`);
		core.setOutput('first', 'true');
		return;
	}

	const tempDir = await fsp.mkdtemp(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'run-once-'));
	try {
		const twirpClient = internalCacheTwirpClient() as TwirpClient;
		const outcome = await claimRun(cacheService(twirpClient, tempDir), key, claimVersion());
		if (outcome.warning) {
			core.warning(outcome.warning);
		}
		core.info(`run-once: ${outcome.reason}`);
		core.setOutput('first', outcome.first ? 'true' : 'false');
	} finally {
		await fsp.rm(tempDir, {recursive: true, force: true});
	}
}

run().catch((error: unknown) => {
	core.setFailed(error instanceof Error ? error.message : String(error));
});
