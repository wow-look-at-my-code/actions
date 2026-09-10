import * as core from '@actions/core';
import { run } from './cleanup';

// The sweep itself lives in cleanup.ts, which exports it and runs nothing on
// import. This file is the action's entry and the only place that reads an
// input or ends the process, so a test may import the sweep and drive it with
// its own arguments.
run({ cwd: '.', dryRun: core.getBooleanInput('dry-run') }).catch((err: unknown) => {
	core.setFailed(err instanceof Error ? err.message : String(err));
});
