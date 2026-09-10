# GitHub Actions

Reusable GitHub Actions.

## Building

Every node action builds with [ts0](https://github.com/wow-look-at-my/ts0), from the `ts0.json` in its directory: `cd <action> && just build`. Get ts0 with `curl -fsSL https://apt.pazer.build/ts0/install.sh | sudo sh && sudo apt-get install ts0`. CI downloads it from buildhost instead.

ts0 supplies the compiler, the bundler and `@types/node`, so an action's `package.json` lists only what it imports at run time. `ts0 test` type-checks the project and runs its test files. `dist/` is not committed. CI builds it before it cuts a release tag.

## Actions

### [Action Validator](action-validator/)

```yml
# Validate GitHub Action action.yml files.
- uses: wow-look-at-my/actions@action-validator#latest
```

### [Branch Block](branch-block/)

```yml
# Add merged branches to a ruleset that blocks re-creation.
- uses: wow-look-at-my/actions@branch-block#latest
  with:
    branch: # Branch name to block
```

### [Cache Cleanup](cache-cleanup/)

```yml
# Delete this run's cache hand-offs and sweep aged ones left by crashed runs (housekeeping for cache-upload/cache-download).
- uses: wow-look-at-my/actions@cache-cleanup#latest
```

### [Cache Download](cache-download/)

```yml
# Restore files handed off by cache-upload earlier in the same workflow run (artifact-free replacement for actions/download-artifact).
- uses: wow-look-at-my/actions@cache-download#latest
```

### [Cache rg](cache-rg/)

```yml
# Install ripgrep from apt with the .deb cached between runs (ubuntu-latest only).
- uses: wow-look-at-my/actions@cache-rg#latest
```

### [Cache Size](cache-size/)

```yml
# Report disk usage breakdown of cached directories.
- uses: wow-look-at-my/actions@cache-size#latest
  with:
    paths: # Directories to measure (newline or space separated)
```

### [Cache Upload](cache-upload/)

```yml
# Hand a file or directory to later jobs in the same workflow run via the actions cache (artifact-free replacement for actions/upload-artifact).
- uses: wow-look-at-my/actions@cache-upload#latest
```

### [Cloudflare Pages](cloudflare-pages/)

```yml
# Publish a directory to Cloudflare Pages by direct upload (wrangler) - no Actions artifacts, no Cloudflare git integration. Credentials come from secret-server via OIDC (the caller must grant id-token: write permission); the first deploy auto-creates the Pages project; missing credentials default to a loud green no-op.
- uses: wow-look-at-my/actions@cloudflare-pages#latest
  with:
    directory: # Built/staged directory to upload
    project-name: # Cloudflare Pages project name (auto-created on first use)
```

### [Common Checks](common-checks/)

```yml
# Run this org's GitHub Actions checks once per workflow run, over the calling repo only.
- uses: wow-look-at-my/actions@common-checks#latest
```

### [Download Executable Artifact](download-exe/)

```yml
# Download an artifact, optionally select/rename files, and set +x.
- uses: wow-look-at-my/actions@download-exe#latest
  with:
    name: # Artifact name to download
```

### [Download Release Binary](download-release-binary/)

```yml
# Download a platform-specific binary from a GitHub release.
- uses: wow-look-at-my/actions@download-release-binary#latest
  with:
    repo: # Repository (owner/name) to download from
```

### [GHCR Prune](ghcr-prune/)

```yml
# Prune old container image versions from GHCR, keeping the last N tagged versions and their referenced untagged versions..
- uses: wow-look-at-my/actions@ghcr-prune#latest
  with:
    image: # Full image reference (e.g., ghcr.io/owner/package:tag)
    keep: # Number of tagged versions to keep
```

### [GHCR](ghcr/)

```yml
# Build, push, and prune container images on GHCR. Every build carries the OCI source and revision labels..
- uses: wow-look-at-my/actions@ghcr#latest
```

### [Has Permission](has-permission/)

```yml
# Report whether a permission is granted to the running job by its job or workflow permissions block.
- uses: wow-look-at-my/actions@has-permission#latest
  with:
    permission: # Permission scope to look for, such as id-token, contents or packages
```

### [Multi-Command](multicmd/)

```yml
# Run OS-specific commands in a single step without boilerplate if-checks.
- uses: wow-look-at-my/actions@multicmd#latest
```

### [no-all-builds-job](no-all-builds-job/)

```yml
# Fail CI when any job is named all-builds — a known trick that shadows the org's required all-builds gate (required-builds-manager) in the GitHub UI.
- uses: wow-look-at-my/actions@no-all-builds-job#latest
```

### [No Scripts Check](no-scripts-action/)

```yml
# Ensures package.json files do not contain scripts sections (use justfiles instead).
- uses: wow-look-at-my/actions@no-scripts-action#latest
```

### [No Tests In YAML](no-tests-in-yaml/)

```yml
# Fail CI when a GitHub Actions YAML file in the local call chain carries a test instead of invoking the repository's own suite.
- uses: wow-look-at-my/actions@no-tests-in-yaml#latest
```

### [Orphan Release](orphan-release/)

```yml
# Create orphan tags from a directory.
- uses: wow-look-at-my/actions@orphan-release#latest
```

### [Push Excludes Tags](push-excludes-tags/)

```yml
# Fail CI when a workflow's push trigger names no ref filter, so tag pushes start it again.
- uses: wow-look-at-my/actions@push-excludes-tags#latest
```

### [Run Once](run-once/)

```yml
# Claim a workflow run for one job, so the work behind the claim runs once per run instead of once per job.
- uses: wow-look-at-my/actions@run-once#latest
  with:
    name: # Claim name, unique per piece of work (the claim is scoped to this run and attempt)
```

### [Fetch Secrets](secret-server/)

```yml
# Fetch secrets from a self-hosted secret server using GitHub Actions OIDC.
- uses: wow-look-at-my/actions@secret-server#latest
```

### [Smart Cache](smart-cache/)

```yml
# Cache with change detection - only saves when files actually changed.
- uses: wow-look-at-my/actions@smart-cache#latest
  with:
    path: # Paths to cache (space-separated)
    key: # Cache key
```

### [ste-lint](ste-lint/)

```yml
# Check the prose a change touches against the mechanical subset of ASD-STE100 Simplified Technical English — sentence length measured over whole sentences rather than wrapped lines, contractions, banned modal verbs, semicolons, comma splices, hard-wrapped paragraphs, and dictionary word choice.
- uses: wow-look-at-my/actions@ste-lint#latest
```

### [Tag Cleanup](tag-cleanup/)

```yml
# Delete orphan-release tags whose action, branch, or version no longer exists.
- uses: wow-look-at-my/actions@tag-cleanup#latest
```

### [Tag Runner Image](tag-runner/)

```yml
# Tags runner images with branch/latest tags and triggers flush.
- uses: wow-look-at-my/actions@tag-runner#latest
  with:
    token: # GitHub token with packages:write and actions:write permissions
```

### [Install timeout (macOS)](timeout-macos/)

```yml
# Makes GNU timeout available on macOS runners by installing coreutils via Homebrew.
- uses: wow-look-at-my/actions@timeout-macos#latest
```

### [TypeScript](typescript/)

```yml
# Run an inline TypeScript script, validated with tsc, with helpful globals pre-injected..
- uses: wow-look-at-my/actions@typescript#latest
```

### [YAML Comment Block](yaml-comment-block/)

```yml
# Fail CI when a GitHub Actions YAML file carries more than 1 comment line in a row.
- uses: wow-look-at-my/actions@yaml-comment-block#latest
```

## Reusable Workflows

### Publish to GHCR

```yml
jobs:
  publish-ghcr:
    uses: wow-look-at-my/actions/.github/workflows/publish-ghcr.yml@master
```

Pass the secret to opt in. A push then notifies docker-updater immediately. A private image does not emit a GitHub package webhook. This is recommended there. The URL defaults to `https://docker-updater-hook.pazer.io/`:

```yml
jobs:
  publish-ghcr:
    uses: wow-look-at-my/actions/.github/workflows/publish-ghcr.yml@master
    secrets:
      updater-webhook-secret: ${{ secrets.DOCKER_UPDATER_WEBHOOK_SECRET }}
```

Set `DOCKER_UPDATER_WEBHOOK_SECRET` (same value as docker-updater's `DOCKER_UPDATER_GITHUB_WEBHOOK_SECRET`) at the org level. A caller that omits the secret keeps the behavior it has today.
