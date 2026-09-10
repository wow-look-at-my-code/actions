#!/usr/bin/env bash
# Exports each key in the JSON object $SECRETS as a masked environment
# variable, via the GITHUB_ENV delimiter format.
#
# jq.exe on Windows writes CRLF line endings, so a key or value read from
# its stdout carries a trailing \r unless stripped. Left in, the variable
# name GO_BUILDCACHE_CONFIG becomes GO_BUILDCACHE_CONFIG\r, and a later
# os.Getenv("GO_BUILDCACHE_CONFIG") finds nothing.
set -uo pipefail

echo "${SECRETS}" | jq -r 'to_entries[] | .key' | tr -d '\r' | while IFS= read -r key; do
	val=$(echo "${SECRETS}" | jq -r --arg k "$key" '.[$k]' | tr -d '\r')
	echo "::add-mask::${val}"
	delimiter="ghadelimiter_$(openssl rand -hex 8)"
	printf '%s<<%s\n%s\n%s\n' "$key" "$delimiter" "$val" "$delimiter" >> "$GITHUB_ENV"
done
