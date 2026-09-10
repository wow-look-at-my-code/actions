// repro2.ts -- dogfood test for the typescript action, run in CI via:
//   uses: wow-look-at-my/actions@typescript#latest
//   with:
//     file: repro2.ts
//
// Regression guard for two things a naive "just compile it as an ES module" fix
// would break:
//   (a) a top-level `export` (rejected as TS1232 when the file was wrapped in an
//       async function body) -- must be accepted; and
//   (b) a top-level `export`/`import` living alongside a top-level `return`. A
//       real ES module cannot contain a top-level `return`; an async function
//       body cannot contain a top-level `import`/`export`. Both must work at
//       once -- the returned value becomes the action's `result` output.

export const VERSION = "1.0.0";

import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
return pkg.version; // top-level return, alongside a top-level import/export
