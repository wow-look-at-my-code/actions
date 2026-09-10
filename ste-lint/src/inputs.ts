// ASD-STE100 rule 6.3 caps a sentence at 25 words. That number is the
// standard's, so no input may go past it: a bigger value does not configure the
// rule, it removes it from the calling workflow, and it does so in a line of
// YAML that reads like a setting. A smaller value is a stricter house style and
// is accepted.

export const STE_MAX_WORDS = 25;

export function capped(name: string, raw: string, fallback: number, ceiling = STE_MAX_WORDS): number {
	const text = raw.trim();
	if (text === '') return fallback;
	const n = Number(text);
	if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive whole number, got "${raw}"`);
	if (n > ceiling) {
		throw new Error(
			`${name}=${n} is above ASD-STE100's own cap of ${ceiling}. ` +
				'That does not configure the rule, it removes it. A smaller number is a stricter house style and is accepted.',
		);
	}
	return n;
}
