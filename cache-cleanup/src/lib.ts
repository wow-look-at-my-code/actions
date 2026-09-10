import {KEY_PREFIX, escapeRegExp} from '../../_shared/cache-xfer/lib';

export {KEY_PREFIX};

/**
 * REST list prefix: always the whole cache-xfer namespace. The current
 * (run-id-first) key layout is `cache-xfer-<run_id>-<name>-<attempt>`, so a
 * hand-off name is no longer a key prefix — name scoping happens client-side
 * via keyMatchesName. The list API's `key` parameter is documented as "An
 * explicit key or prefix for identifying the cache".
 */
export function listPrefix(): string {
	return `${KEY_PREFIX}-`;
}

/**
 * Does `key` belong to run `runId` (any attempt), optionally scoped to one
 * hand-off name? Matches BOTH key layouts during the v2 transition:
 *
 *   current: `cache-xfer-<runId>-<name>-<attempt>`  (run-id-first)
 *   legacy:  `cache-xfer-<name>-<runId>-<attempt>`  (pre-v2; TRANSITION —
 *            keep until no pre-v2 cache-upload can still be producing)
 *
 * The dashes around runId anchor it, so a runId can never match inside
 * another run's longer id.
 */
export function isRunEntry(key: string, runId: string, name?: string): boolean {
	const nameSegment = name === undefined ? '.+' : escapeRegExp(name);
	const run = escapeRegExp(runId);
	const current = new RegExp(`^${KEY_PREFIX}-${run}-${nameSegment}-\\d+$`);
	const legacy = new RegExp(`^${KEY_PREFIX}-${nameSegment}-${run}-\\d+$`);
	return current.test(key) || legacy.test(key);
}

/**
 * Does `key` carry hand-off name `name` under EITHER layout? Used to scope
 * the aged sweep client-side (the run-id-first layout made name-prefix
 * listing impossible). A key whose two interpretations disagree (an
 * all-numeric name) matches if either reads as `name` — over-matching is
 * acceptable for cleanup, under-matching would leak entries.
 */
export function keyMatchesName(key: string, name: string): boolean {
	const escaped = escapeRegExp(name);
	const current = new RegExp(`^${KEY_PREFIX}-\\d+-${escaped}-\\d+$`);
	const legacy = new RegExp(`^${KEY_PREFIX}-${escaped}-\\d+-\\d+$`);
	return current.test(key) || legacy.test(key);
}

/** Parse a max-age like '12h', '90m', '2d'; '0' disables. Returns milliseconds. */
export function parseMaxAge(input: string): number {
	const trimmed = input.trim();
	if (trimmed === '0') {
		return 0;
	}
	const match = /^(\d+)([mhd])$/.exec(trimmed);
	if (!match) {
		throw new Error(`Invalid max-age '${input}': use <number>m|h|d (e.g. '12h'), or '0' to disable the sweep`);
	}
	const value = Number(match[1]);
	const unitMs = {m: 60_000, h: 3_600_000, d: 86_400_000}[match[2] as 'm' | 'h' | 'd'];
	return value * unitMs;
}

/**
 * Is the entry older than maxAge? Uses last_accessed_at (falling back to
 * created_at) from the REST response. Unknown timestamps are never swept.
 */
export function isAgedOut(lastAccessedAt: string | undefined, createdAt: string | undefined, nowMs: number, maxAgeMs: number): boolean {
	if (maxAgeMs <= 0) {
		return false;
	}
	const stamp = lastAccessedAt ?? createdAt;
	if (!stamp) {
		return false;
	}
	const t = Date.parse(stamp);
	if (Number.isNaN(t)) {
		return false;
	}
	return nowMs - t > maxAgeMs;
}
