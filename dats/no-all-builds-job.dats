# The guard has three layers, and each one has to be driven separately: the
# file scan, the API layers, and the run-once sentinel that skips all of them.
# release.yml used to spell these out as six bash steps.
#
# The shadowed fixture is stored flat, outside any .github/workflows path. A
# workflow file in the tree is walked by the org's own YAML rules, and the
# fixture breaks one on purpose. So each test builds the workspace it needs.

sandbox:
	network: false

tests:
	- desc: the file scan fails on a workflow whose job is named all-builds
	  exit: 1
	  cmd: w=$(mktemp -d) && mkdir -p "$w/.github/workflows" && cp no-all-builds-job/test/fixtures/shadowed-ci.yml.fixture "$w/.github/workflows/ci.yml" && env NO_ALL_BUILDS_JOB_ALREADY_RAN= GITHUB_WORKSPACE="$w" INPUT_TOKEN= node no-all-builds-job/dist/index.js

	- desc: a layer that cannot scan is a blocking error, never a pass
	  exit: 1
	  cmd: env NO_ALL_BUILDS_JOB_ALREADY_RAN= INPUT_TOKEN=x node no-all-builds-job/dist/index.js

	- desc: the sentinel skips the guard before the shadowed fixture is read
	  exit: 0
	  cmd: w=$(mktemp -d) && mkdir -p "$w/.github/workflows" && cp no-all-builds-job/test/fixtures/shadowed-ci.yml.fixture "$w/.github/workflows/ci.yml" && env NO_ALL_BUILDS_JOB_ALREADY_RAN=1 GITHUB_WORKSPACE="$w" INPUT_TOKEN=x node no-all-builds-job/dist/index.js
