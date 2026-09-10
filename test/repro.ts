// repro.ts -- dogfood test for the typescript action, run in CI via:
//   uses: wow-look-at-my/actions@typescript#latest
//   with:
//     file: repro.ts
//
// Regression guard. The action splits this file so the top-level `import` stays
// at module scope while the rest becomes the body of an async function. Before
// that hoisting, tsc rejected the import with:
//   error TS1232: An import declaration can only be used at the top level of a
//   namespace or module.
// ...because the action wrapped the whole file in an async function body, where
// a top-level `import` is illegal. It must keep compiling under strict tsc and
// running.

import { setTimeout as sleep } from "node:timers/promises"; // top-level import

// Injected globals (ambiently declared in globals.d.ts) must still resolve:
core.info(`workspace = ${path.join(env.GITHUB_WORKSPACE ?? ".", "package.json")}`);

await sleep(10); // top-level await (must keep working)

const res = await fetch("https://api.github.com/zen"); // global fetch from @types/node
core.info(`zen: ${(await res.text()).trim()}`);
