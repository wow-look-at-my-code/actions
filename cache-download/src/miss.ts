// Download-only module (NOT part of the shared cache-xfer sources used by
// cache-upload): decides what happens when the hand-off lookup misses.

/** What a hand-off lookup miss does to the step. */
export interface MissOutcome {
	/** true: fail the step (core.setFailed); false: log and continue. */
	fail: boolean;
	message: string;
}

/**
 * The `fail-if-missing` input defaults to 'true' in action.yml, so an unset
 * input means a miss HARD-FAILS the step — only an explicit 'false' lets the
 * job continue without its files (cache-hit stays 'false', cache-matched-key
 * empty). Either way the message names the hand-off, the exact key tried,
 * and the restore prefix — plus the pre-v2 legacy layout the named download
 * also fell back to — so a miss is never mysterious.
 */
export function missOutcome(name: string, key: string, restorePrefix: string, failIfMissing: boolean): MissOutcome {
	const detail = `Hand-off '${name}' was not found for this workflow run (tried exact key ${key}, restore prefix ${restorePrefix}, and the pre-v2 legacy key layout)`;
	if (failIfMissing) {
		return {fail: true, message: `${detail}. Did the producing job run cache-upload with the same name?`};
	}
	return {fail: false, message: `${detail}; continuing without it (fail-if-missing is false)`};
}

/**
 * The nameless-discovery miss: nothing under the run-scoped prefix. There is
 * deliberately NO legacy-layout fallback here (a nameless old-layout prefix
 * search is exactly the cross-run bug the v2 layout fixed), so the message
 * points at old producers too.
 */
export function namelessMissOutcome(runPrefix: string, failIfMissing: boolean): MissOutcome {
	const detail = `No hand-off was found for this workflow run (searched prefix ${runPrefix})`;
	const hint = 'Did an earlier job run cache-upload in this run? A producer still on the pre-v2 cache-upload is invisible to nameless discovery — pass an explicit name to use the legacy fallback.';
	if (failIfMissing) {
		return {fail: true, message: `${detail}. ${hint}`};
	}
	return {fail: false, message: `${detail}; continuing without it (fail-if-missing is false). ${hint}`};
}
