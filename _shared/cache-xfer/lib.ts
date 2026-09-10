import * as crypto from 'crypto';

// The single copy of the cache-xfer wire format: key layout, envelope, and
// the constant version seed. cache-upload, cache-download, and cache-cleanup
// all import it from here -- a second copy would fork the format silently.

/** Key prefix shared by cache-upload, cache-download, and cache-cleanup. */
export const KEY_PREFIX = 'cache-xfer';

/**
 * Seed of the constant cache "version" sent to the cache service.
 *
 * The service treats `version` as an opaque request parameter alongside the
 * key; the path/compression-derived sha256 that actions/cache sends is purely
 * client-side convention (computed in @actions/cache 5.2.0,
 * lib/internal/cacheUtils.js:202-217, from the literal path spec strings). We
 * send sha256 of this literal instead, so version never depends on user
 * input and upload/download need no path contract at all.
 *
 * Bump the trailing revision whenever the envelope layout or codec set
 * changes: mixed-revision producers/consumers then land on different
 * versions, turning a would-be misparse into a clean cache miss.
 *
 * v2: run-id-first key layout (`cache-xfer-<run_id>-<name>-<attempt>`) and
 * the envelope header now carries the hand-off `name` (nameless discovery).
 */
export const VERSION_SEED = 'wow-look-at-my/actions/cache-xfer/v2';

/**
 * TRANSITION (remove with the named-download legacy fallback once the v2
 * rollout is done): the v1 seed, still sent by pre-v2 cache-upload
 * producers. A NAMED download falls back to the v1 (key, version) pair when
 * the v2 lookup misses, so a new-layout consumer riding `#latest` keeps
 * working against an old-layout producer mid-rollout.
 */
export const LEGACY_VERSION_SEED = 'wow-look-at-my/actions/cache-xfer/v1';

/** Magic bytes opening every hand-off archive. */
export const ENVELOPE_MAGIC = 'WXFR1';

/** The cache service rejects keys longer than 512 characters. */
const MAX_KEY_LENGTH = 512;

/** Sanity bound for the envelope's JSON header. */
export const MAX_HEADER_BYTES = 64 * 1024;

export function validateName(name: string): void {
	if (!name) {
		throw new Error("The 'name' input must not be empty");
	}
	if (name.includes(',')) {
		throw new Error("The 'name' input must not contain commas (commas are invalid in cache keys)");
	}
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Exact key for this hand-off: unique per (name, run, attempt). The run id
 * comes FIRST so every key of one run shares the run-scoped prefix below —
 * that is what makes nameless discovery safe: a prefix search scoped to the
 * current run can never match another run's entry (the dash after the run
 * id anchors it against longer run ids).
 */
export function handoffKey(name: string, runId: string, runAttempt: string): string {
	const key = `${KEY_PREFIX}-${runId}-${name}-${runAttempt}`;
	if (key.length > MAX_KEY_LENGTH) {
		throw new Error(`Hand-off cache key is ${key.length} characters; the cache service allows at most ${MAX_KEY_LENGTH}. Use a shorter 'name'.`);
	}
	return key;
}

/**
 * Name-scoped restore prefix: matches any attempt of this run, so
 * "re-run failed jobs" (new attempt, producer not re-run) still restores the
 * newest earlier attempt's files.
 */
export function handoffRestorePrefix(name: string, runId: string): string {
	return `${KEY_PREFIX}-${runId}-${name}-`;
}

/**
 * Run-scoped restore prefix: matches EVERY hand-off of this run (any name,
 * any attempt) — the nameless-discovery search. The run-id-first key layout
 * guarantees it can never cross runs.
 */
export function runRestorePrefix(runId: string): string {
	return `${KEY_PREFIX}-${runId}-`;
}

/**
 * Extract the hand-off name from a (current-layout) key of run `runId`, or
 * undefined for anything else — old-layout keys, other runs, foreign
 * namespaces. The attempt segment is numeric-terminal, so a name containing
 * dashes (even dash-digit segments) parses greedily and correctly.
 */
export function nameFromKey(key: string, runId: string): string | undefined {
	const match = new RegExp(`^${KEY_PREFIX}-${escapeRegExp(runId)}-(.+)-\\d+$`).exec(key);
	return match?.[1];
}

/** The constant version sent with every CreateCacheEntry/GetCacheEntryDownloadURL. */
export function handoffVersion(): string {
	return crypto.createHash('sha256').update(VERSION_SEED).digest('hex');
}

// ---------------------------------------------------------------------------
// TRANSITION (remove with the named-download legacy fallback once every
// producer runs a v2 cache-upload): the pre-v2 key layout put the name first
// — `cache-xfer-<name>-<run_id>-<attempt>` — which is exactly why nameless
// discovery was impossible (a nameless prefix search could match another
// run's entry). Only a NAMED download may consult these; a nameless
// old-layout prefix search would reintroduce the cross-run bug.
// ---------------------------------------------------------------------------

/** TRANSITION: exact key under the pre-v2 (name-first) layout. */
export function legacyHandoffKey(name: string, runId: string, runAttempt: string): string {
	return `${KEY_PREFIX}-${name}-${runId}-${runAttempt}`;
}

/** TRANSITION: restore prefix under the pre-v2 (name-first) layout. */
export function legacyHandoffRestorePrefix(name: string, runId: string): string {
	return `${KEY_PREFIX}-${name}-${runId}-`;
}

/** TRANSITION: the version pre-v2 producers saved under. */
export function legacyHandoffVersion(): string {
	return crypto.createHash('sha256').update(LEGACY_VERSION_SEED).digest('hex');
}

/**
 * Self-describing envelope, so the download side needs nothing from the key:
 *
 *   'WXFR1' | uint32 BE header length | header JSON | compressed payload
 *
 * mode 'raw' is the single-file fast path (no tar process at all): the file
 * body is streamed straight through the codec, and basename/fileMode let the
 * download side recreate `<dest>/<basename>` with its permission bits.
 * mode 'tar' carries a directory's contents as a tar stream (exec bits and
 * symlinks preserved by tar itself).
 *
 * `name` is the hand-off name the producer saved under — what lets a
 * nameless download report which hand-off it picked without trusting the
 * key. Optional on parse: v1 envelopes (reachable only through the named
 * download's TRANSITION legacy fallback) predate it.
 */
export interface EnvelopeHeader {
	mode: 'tar' | 'raw';
	codec: 'zstd';
	name?: string;
	basename?: string;
	fileMode?: number;
}

export function encodeEnvelope(header: EnvelopeHeader): Buffer {
	const json = Buffer.from(JSON.stringify(header), 'utf8');
	const len = Buffer.alloc(4);
	len.writeUInt32BE(json.length, 0);
	return Buffer.concat([Buffer.from(ENVELOPE_MAGIC, 'latin1'), len, json]);
}

/**
 * Parse the envelope prefix from the first bytes of an archive. `buf` must
 * contain at least the magic, length, and full header JSON. Returns the
 * validated header plus the offset at which the compressed payload starts.
 */
export function parseEnvelope(buf: Buffer): {header: EnvelopeHeader; dataOffset: number} {
	const magic = Buffer.from(ENVELOPE_MAGIC, 'latin1');
	if (buf.length < magic.length + 4) {
		throw new Error('Hand-off archive is truncated (no envelope header)');
	}
	if (!buf.subarray(0, magic.length).equals(magic)) {
		throw new Error(`Hand-off archive does not start with the ${ENVELOPE_MAGIC} magic; it was not written by cache-upload`);
	}
	const headerLen = buf.readUInt32BE(magic.length);
	if (headerLen > MAX_HEADER_BYTES) {
		throw new Error(`Envelope header length ${headerLen} exceeds the ${MAX_HEADER_BYTES} byte bound`);
	}
	const headerStart = magic.length + 4;
	if (buf.length < headerStart + headerLen) {
		throw new Error('Hand-off archive is truncated (incomplete envelope header)');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(buf.subarray(headerStart, headerStart + headerLen).toString('utf8'));
	} catch {
		throw new Error('Envelope header is not valid JSON');
	}
	const header = parsed as EnvelopeHeader;
	if (header === null || typeof header !== 'object') {
		throw new Error('Envelope header is not a JSON object');
	}
	if (header.mode !== 'tar' && header.mode !== 'raw') {
		throw new Error(`Envelope mode '${String(header.mode)}' is not supported by this version of the action`);
	}
	if (header.codec !== 'zstd') {
		throw new Error(`Envelope codec '${String(header.codec)}' is not supported by this version of the action`);
	}
	if (header.name !== undefined && (typeof header.name !== 'string' || header.name === '')) {
		throw new Error(`Envelope name ${JSON.stringify(header.name)} is not a non-empty string`);
	}
	if (header.mode === 'raw') {
		if (typeof header.basename !== 'string' || header.basename === '' || header.basename === '.' || header.basename === '..' || header.basename.includes('/') || header.basename.includes('\\')) {
			throw new Error(`Envelope basename ${JSON.stringify(header.basename)} is missing or unsafe`);
		}
		if (header.fileMode !== undefined && (typeof header.fileMode !== 'number' || !Number.isInteger(header.fileMode) || header.fileMode < 0 || header.fileMode > 0o7777)) {
			throw new Error(`Envelope fileMode ${JSON.stringify(header.fileMode)} is not a valid mode`);
		}
	}
	return {header, dataOffset: headerStart + headerLen};
}
