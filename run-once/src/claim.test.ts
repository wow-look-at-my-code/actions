import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CLAIM_PAYLOAD, ClaimService, CreateResult, FinalizeResult, claimKey, claimRun, claimVersion, validateName} from '../../_shared/run-claim/claim';

interface Calls {
	create: number;
	upload: number;
	finalize: number;
	exists: number;
}

function service(overrides: Partial<ClaimService>): {service: ClaimService; calls: Calls} {
	const calls: Calls = {create: 0, upload: 0, finalize: 0, exists: 0};
	const wrapped: ClaimService = {
		create: async (key, version): Promise<CreateResult> => {
			calls.create++;
			return overrides.create ? overrides.create(key, version) : {ok: true, signedUploadUrl: 'https://blob.example/claim'};
		},
		upload: async (url): Promise<number> => {
			calls.upload++;
			return overrides.upload ? overrides.upload(url) : CLAIM_PAYLOAD.length;
		},
		finalize: async (key, version, sizeBytes): Promise<FinalizeResult> => {
			calls.finalize++;
			return overrides.finalize ? overrides.finalize(key, version, sizeBytes) : {ok: true};
		},
		exists: async (key, version): Promise<boolean> => {
			calls.exists++;
			return overrides.exists ? overrides.exists(key, version) : false;
		}
	};
	return {service: wrapped, calls};
}

const KEY = 'run-once-42-1-common-checks';
const VERSION = claimVersion();

test('the claim key is unique per run, attempt, and name', () => {
	assert.equal(claimKey('common-checks', '42', '1'), KEY);
	assert.notEqual(claimKey('common-checks', '42', '2'), claimKey('common-checks', '42', '1'));
	assert.notEqual(claimKey('common-checks', '43', '1'), claimKey('common-checks', '42', '1'));
});

test('the claim version is a stable hash', () => {
	assert.match(claimVersion(), /^[0-9a-f]{64}$/);
	assert.equal(claimVersion(), VERSION);
});

test('a name that cannot be part of a cache key is rejected', () => {
	assert.throws(() => validateName(''), /must not be empty/);
	assert.throws(() => validateName('a,b'), /must not contain commas/);
});

test('a key longer than the service allows is rejected', () => {
	assert.throws(() => claimKey('x'.repeat(600), '42', '1'), /allows at most 512/);
});

test('the first job stores the claim and runs the work', async () => {
	const {service: s, calls} = service({});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.equal(outcome.warning, undefined);
	assert.deepEqual(calls, {create: 1, upload: 1, finalize: 1, exists: 0});
});

test('a later job whose claim collides with a stored entry skips the work', async () => {
	const {service: s, calls} = service({
		create: async () => ({ok: false, message: 'already exists'}),
		exists: async () => true
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, false);
	assert.equal(outcome.warning, undefined);
	assert.match(outcome.reason, /another job of this run holds the claim/);
	assert.deepEqual(calls, {create: 1, upload: 0, finalize: 0, exists: 1});
});

test('a refused claim with no stored entry runs the work and warns', async () => {
	const {service: s} = service({
		create: async () => ({ok: false, message: 'cache is read-only'}),
		exists: async () => false
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /cache is read-only/);
});

test('a lookup that throws after a refused claim runs the work and warns', async () => {
	const {service: s} = service({
		create: async () => ({ok: false, message: 'no'}),
		exists: async () => {
			throw new Error('lookup exploded');
		}
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /lookup exploded/);
});

test('a create that throws runs the work and warns', async () => {
	const {service: s, calls} = service({
		create: async () => {
			throw new Error('service unreachable');
		}
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /service unreachable/);
	assert.equal(calls.exists, 0);
});

test('a reservation with no upload URL runs the work and warns', async () => {
	const {service: s, calls} = service({
		create: async () => ({ok: true})
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /no upload URL/);
	assert.equal(calls.upload, 0);
});

// The live service does not answer a collision with ok:false. It throws a 409,
// which used to read as an unreachable service, so every job failed open and
// ran the work -- the whole point of the claim, lost.
const CONFLICT = 'Failed to CreateCacheEntry: Received non-retryable error: Failed request: (409) Conflict: cache entry with the same key, version, and scope already exists';

test('a create that throws a conflict skips the work when the entry is really there', async () => {
	const {service: s, calls} = service({
		create: async () => {
			throw new Error(CONFLICT);
		},
		exists: async () => true
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, false);
	assert.equal(outcome.warning, undefined);
	assert.match(outcome.reason, /another job of this run holds the claim/);
	assert.deepEqual(calls, {create: 1, upload: 0, finalize: 0, exists: 1});
});

// The negative control: a claim is only surrendered on a POSITIVE lookup.
test('a create that throws a conflict still runs the work when no entry is there', async () => {
	const {service: s} = service({
		create: async () => {
			throw new Error(CONFLICT);
		},
		exists: async () => false
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /could not reach the cache service/);
});

test('a create that throws a conflict runs the work when the lookup itself fails', async () => {
	const {service: s} = service({
		create: async () => {
			throw new Error(CONFLICT);
		},
		exists: async () => {
			throw new Error('lookup exploded');
		}
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /could not reach the cache service/);
});

// A genuinely unreachable service must not consult the lookup at all.
test('a create that throws something other than a conflict runs the work without a lookup', async () => {
	const {service: s, calls} = service({
		create: async () => {
			throw new Error('ECONNREFUSED');
		},
		exists: async () => true
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /ECONNREFUSED/);
	assert.equal(calls.exists, 0);
});

test('an upload that throws runs the work and warns', async () => {
	const {service: s} = service({
		upload: async () => {
			throw new Error('blob PUT failed');
		}
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /blob PUT failed/);
});

test('a claim that never finalizes runs the work and warns', async () => {
	const {service: s} = service({
		finalize: async () => ({ok: false, message: 'finalize rejected'})
	});
	const outcome = await claimRun(s, KEY, VERSION);
	assert.equal(outcome.first, true);
	assert.match(outcome.warning as string, /finalize rejected/);
});

test('the finalized size is the payload the upload wrote', async () => {
	let seen = -1;
	const {service: s} = service({
		finalize: async (_key, _version, sizeBytes) => {
			seen = sizeBytes;
			return {ok: true};
		}
	});
	await claimRun(s, KEY, VERSION);
	assert.equal(seen, CLAIM_PAYLOAD.length);
});
