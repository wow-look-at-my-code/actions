// An unnamed step shows in the log as the action it runs, so every unnamed
// typescript step reads `Run wow-look-at-my/actions@typescript#latest`. The
// script is the whole point of the step and the name is the only place its
// purpose can appear.

export interface WorkflowStep {
	name?: unknown;
	uses?: unknown;
	id?: unknown;
}

export interface WorkflowDoc {
	jobs?: Record<string, {steps?: unknown} | null>;
}

/** True for a `uses:` that runs this action, published or as a local path. */
export function runsTypescriptAction(uses: unknown): boolean {
	if (typeof uses !== 'string') return false;
	const ref = uses.trim();
	return /(^|\/)actions@typescript(#|$)/.test(ref) || /(^|\/)typescript\/?$/.test(ref);
}

/**
 * The 1-based positions, among a job's steps, of every typescript step with no
 * `name:`. A step reached through a composite action does not appear in the
 * workflow file, so that case yields nothing and the caller stays quiet.
 */
export function unnamedSteps(doc: WorkflowDoc, job: string): number[] {
	const steps = doc.jobs?.[job]?.steps;
	if (!Array.isArray(steps)) return [];
	const found: number[] = [];
	steps.forEach((raw, i) => {
		const step = raw as WorkflowStep | null;
		if (!step || !runsTypescriptAction(step.uses)) return;
		const name = step.name;
		if (typeof name === 'string' && name.trim()) return;
		found.push(i + 1);
	});
	return found;
}

export function unnamedStepMessage(workflow: string, job: string, positions: number[]): string {
	const where = positions.map((p) => `step ${p}`).join(', ');
	return (
		`${workflow}: job '${job}' runs this action with no \`name:\` (${where}). ` +
		'An unnamed step logs as the action, so the log says nothing about what the script does. ' +
		'Give the step a `name:` describing the script.'
	);
}
