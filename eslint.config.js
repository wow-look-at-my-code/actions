// Flat ESLint config (eslint.config.js) -- the combined "fake-string" guard.
//
// This single config enables the rules that defend against the
// branded-primitive / boxed-`String` regression (where a value typed as a
// `string` is actually a boxed wrapper object at runtime, so `out.stdout === "x"`
// is always false and `fs.writeFileSync(p, out.stdout)` throws):
//
//   1. local/no-callable-primitive-intersection  (custom, AST-only) -- root cause
//   2. local/no-branded-primitive-comparison      (custom, type-aware) -- usage
//   3. no-new-wrappers                             (stock core) -- boxing call
//   4. @typescript-eslint/no-wrapper-object-types  (stock TS) -- boxed type
//   5. no-restricted-syntax: Object(x)             (stock core) -- boxing coercion
//
// TYPE-AWARE: rule #2 needs the TypeScript TypeChecker, so the parser is the
// typescript-eslint parser with `projectService: true` + `tsconfigRootDir`,
// which auto-discovers the nearest tsconfig.json for each linted file. The
// AST-only rule (#1) and the stock rules run fine under the same parser -- they
// simply ignore the type information.
//
// Scope: the action's own TypeScript sources under src/ plus globals.d.ts. Test
// sources (src/*.test.ts) are excluded -- they live outside tsconfig's program
// (the action's tsconfig excludes them) and their `===` examples are strings
// inside `runAction(...)` snippets, not real comparisons for the rule to judge.

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

// The two custom rules, copied verbatim under ./eslint-rules/.
const noCallablePrimitiveIntersection = require('./eslint-rules/no-callable-primitive-intersection.js');
const noBrandedPrimitiveComparison = require('./eslint-rules/no-branded-primitive-comparison.js');

// Register the two custom rules under a `local` plugin namespace so they can be
// referenced as `local/<name>`.
const localPlugin = {
  rules: {
    'no-callable-primitive-intersection': noCallablePrimitiveIntersection,
    'no-branded-primitive-comparison': noBrandedPrimitiveComparison,
  },
};

module.exports = [
  {
    // Global ignores (a config object with ONLY `ignores`). Keep ESLint off the
    // built bundle and dependencies -- `just build` runs before `just lint` in
    // CI, so dist/ exists and would otherwise be linted (it is 11 MB of bundled
    // third-party code carrying its own disable directives for rules we don't
    // load). The config files and rule sources are plain CommonJS outside the
    // action's tsconfig program, so exclude them from the type-aware pass too.
    ignores: [
      'dist/**',
      'node_modules/**',
      'eslint.config.js',
      'eslint-rules/**',
    ],
  },
  {
    // Lint only files that are part of the action's tsconfig program, so the
    // type-aware rule has type info: src/ (minus tests, see `ignores`) and the
    // ambient globals.d.ts.
    files: ['src/**/*.ts', 'globals.d.ts'],
    // Test sources are excluded from tsconfig's program; linting them with
    // projectService would force them onto the default (inferred) project.
    ignores: ['src/**/*.test.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        // Type information for the type-aware comparison rule. `projectService`
        // auto-discovers the nearest tsconfig.json per file (here,
        // typescript/tsconfig.json). The tsconfig MUST `include` the linted
        // files or the parser cannot build a Program for them.
        projectService: true,
        tsconfigRootDir: __dirname,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      // Custom rules live here -> referenced as `local/...`.
      local: localPlugin,
      // The official TS plugin supplies `@typescript-eslint/no-wrapper-object-types`.
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // (1) ROOT CAUSE, AST-only: flags a primitive type intersected with an
      //     inline object that has a CALLABLE member -- e.g.
      //     `type Fake = string & { json<T>(): T }`. Such a type can only be
      //     satisfied at runtime by a boxed wrapper that lies about being a
      //     primitive. This is the type definition that creates fake strings.
      'local/no-callable-primitive-intersection': 'error',

      // (2) USAGE, type-aware: flags `===`/`!==`/`==`/`!=`/`switch` comparing a
      //     branded primitive (boxed at runtime) against a real primitive --
      //     the comparison is always false. Needs the TypeChecker (above).
      'local/no-branded-primitive-comparison': 'error',

      // (3) Bans `new String()` / `new Number()` / `new Boolean()` -- the actual
      //     runtime boxing call that materializes a wrapper object.
      'no-new-wrappers': 'error',

      // (4) Bans `String` / `Number` / `Boolean` / `Object` / `{}` in TYPE
      //     positions -- the boxed-wrapper intent expressed at the type level.
      '@typescript-eslint/no-wrapper-object-types': 'error',

      // (5) Bans `Object(x)` single-arg coercion-boxing, an equivalent boxing
      //     path that `no-new-wrappers` does NOT catch.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='Object'][arguments.length=1]",
          message:
            'Do not box a value with Object(...) -- it produces a wrapper object (the boxed-stream regression). Use the primitive directly.',
        },
      ],
    },
  },
];
