# jq.exe on Windows writes CRLF, so a key or value read off its stdout can
# carry a trailing \r. Left in, GO_BUILDCACHE_CONFIG becomes the literal
# variable name GO_BUILDCACHE_CONFIG\r, and go-toolchain's own
# os.Getenv("GO_BUILDCACHE_CONFIG") then finds nothing set.
#
# A real jq.exe is not available here, so a wrapper stands in for it: real
# jq's output, with \r appended to every line, the same shape Windows
# produces. export-secrets.sh must still emit clean keys and values through
# it.
sandbox:
	network: false

shared:
	files:
		fakejq: |
			#!/usr/bin/env bash
			exec "$REAL_JQ" "$@" | sed 's/$/\r/'

tests:
	- desc: a key survives a CRLF-emitting jq (Windows jq.exe) intact
	  exit: 0
	  inputs:
		files:
			run.sh: |
				set -uo pipefail
				work="$(mktemp -d)"
				REAL_JQ="$(command -v jq)"
				export REAL_JQ
				mkdir -p "$work/fakebin"
				cp {shared.fakejq} "$work/fakebin/jq"
				chmod +x "$work/fakebin/jq"
				export PATH="$work/fakebin:$PATH"

				export SECRETS='{"GO_BUILDCACHE_CONFIG":"abc123","OTHER_KEY":"xyz"}'
				export GITHUB_ENV="$work/github_env"
				: > "$GITHUB_ENV"
				bash "$SCRIPT"

				grep -q '^GO_BUILDCACHE_CONFIG<<' "$GITHUB_ENV" && echo "KEY_CLEAN=yes" || echo "KEY_CLEAN=no"
				grep -q '^OTHER_KEY<<' "$GITHUB_ENV" && echo "OTHER_KEY_CLEAN=yes" || echo "OTHER_KEY_CLEAN=no"
				grep -Pq '\r' "$GITHUB_ENV" && echo "HAS_CR=yes" || echo "HAS_CR=no"
	  cmd: env SCRIPT="$PWD/secret-server/export-secrets.sh" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "KEY_CLEAN=yes"
			- "OTHER_KEY_CLEAN=yes"
			- "HAS_CR=no"

	# The ordinary case, a real (non-CRLF) jq, must keep working the same way.
	- desc: a key survives an ordinary jq unchanged
	  exit: 0
	  inputs:
		files:
			run.sh: |
				set -uo pipefail
				work="$(mktemp -d)"
				export SECRETS='{"GO_BUILDCACHE_CONFIG":"abc123"}'
				export GITHUB_ENV="$work/github_env"
				: > "$GITHUB_ENV"
				bash "$SCRIPT"
				grep -q '^GO_BUILDCACHE_CONFIG<<' "$GITHUB_ENV" && echo "KEY_CLEAN=yes" || echo "KEY_CLEAN=no"
	  cmd: env SCRIPT="$PWD/secret-server/export-secrets.sh" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "KEY_CLEAN=yes"
