// repro3.ts -- dogfood test for the typescript action, run in CI via:
//   uses: ./typescript
//   with:
//     file: typescript/test/repro3.ts
//
// Regression guard for the injected `octokit` being authenticated OUT OF THE BOX.
// The README promises `octokit` is "pre-authenticated"; this proves it for real,
// using ONLY the default `github-token` input (which defaults to the automatic
// ${{ github.token }}) -- no `secrets:` plumbing, no `getOctokit(...)` call.
//
// Before the fix, the pre-authenticated octokit was built from
// process.env.GITHUB_TOKEN, which the runner does NOT place in the action
// process env. The first `octokit.rest.*` access therefore threw:
//   Error: Parameter token or opts.auth is required
// This step makes a real authenticated API call; an unauthenticated octokit
// fails it, the action setFailed()s (non-zero exit), and the CI step goes red.

const { data } = await octokit.rest.repos.get(context.repo);

const expected = `${context.repo.owner}/${context.repo.repo}`;
core.info(`octokit.rest.repos.get -> ${data.full_name} (expected ${expected})`);

if (data.full_name !== expected) {
	throw new Error(`octokit.rest.repos.get returned '${data.full_name}', expected '${expected}'`);
}

core.info('repro3 OK: injected octokit was authenticated with the default github-token');
