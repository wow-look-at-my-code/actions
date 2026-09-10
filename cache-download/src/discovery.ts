// Download-only module (NOT part of the shared cache-xfer sources used by
// cache-upload): nameless discovery — turning "the hand-offs this run
// saved" into a single unambiguous pick, or a loud refusal.
//
// The pinned @actions/cache 5.2.0 twirp client exposes no list RPC (only
// CreateCacheEntry / FinalizeCacheEntryUpload / GetCacheEntryDownloadURL),
// so listing uses the DOCUMENTED public REST API cache-cleanup already
// relies on: GET /repos/{owner}/{repo}/actions/caches with `key` as a
// prefix ("An explicit key or prefix for identifying the cache"). That
// endpoint needs a github-token with `actions: read`; the twirp
// ACTIONS_RUNTIME_TOKEN cannot call it. When no usable token is available
// the ambiguity check degrades to a warning and the newest run-scoped entry
// is restored — which is why multi-producer runs must keep explicit names
// (see action.yml / README).

import {nameFromKey} from '../../_shared/cache-xfer/lib';

/**
 * Distinct current-layout hand-off names among the listed keys of run
 * `runId`, in listing order. Attempts dedupe by construction (the attempt
 * segment is stripped), so a re-run never manufactures ambiguity; old-layout
 * and foreign keys are ignored.
 */
export function distinctHandoffNames(keys: string[], runId: string): string[] {
	const names: string[] = [];
	for (const key of keys) {
		const name = nameFromKey(key, runId);
		if (name !== undefined && !names.includes(name)) {
			names.push(name);
		}
	}
	return names;
}

/**
 * The hard-error for an ambiguous nameless download. Deliberately a refusal,
 * never a silent pick: the candidates are named so the fix ("pass one of
 * these as `name`", or stop producing the extra hand-off) is obvious.
 */
export function ambiguityMessage(names: string[]): string {
	const listed = names.map(n => `'${n}'`).join(', ');
	return `This run saved ${names.length} distinct hand-offs (${listed}); a nameless cache-download refuses to pick one. Pass one of them as the 'name' input, or stop uploading the extra hand-off.`;
}
