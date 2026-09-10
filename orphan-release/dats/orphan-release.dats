# orphan-release.sh publishes two tags: a numbered one that is immutable and
# unique to the run, and #latest, a pointer every concurrent release moves.
# GitHub applies one push in one ref transaction, so while both refs travelled
# together, a run that lost the race for #latest had its whole push rejected --
# taking down the numbered tag, which was never contested. The release then had
# no tag at all, and callers papered over it by repeating the step.
#
# A real race is not reproducible on demand. The remote refuses the pointer
# instead: a pre-receive hook that rejects #latest stands in for losing the
# race, and the question is only what happens to the OTHER ref in the same
# push. Run this suite against the one-push version and the two
# NUMBERED_TAG_PUBLISHED cases fail.
#
# Every push goes to a local bare repository, so this needs no token and no
# network.
sandbox:
	network: false

shared:
	files:
		# make_origin builds a bare repo. Given a ref name, its pre-receive
		# hook refuses any push carrying that ref, which is what losing a lock
		# looks like from the client.
		#
		# release runs the script the way the action does. The script builds
		# its push URL out of GITHUB_REPOSITORY, so the URL is sent to the
		# local bare repo through git's own insteadOf, in the environment
		# rather than in a config file. Nothing in the script changes for the
		# test's benefit.
		lib.sh: |
			set -uo pipefail
			REMOTE_URL="https://x-access-token:@github.com/owner/repo"

			make_origin() {
			  local dir="$1" reject="${2:-}"
			  git init --quiet --bare "$dir"
			  if [ -n "$reject" ]; then
			    cat > "$dir/hooks/pre-receive" <<HOOK
			#!/usr/bin/env bash
			while read -r _old _new ref; do
			  if [ "\$ref" = "$reject" ]; then
			    echo "rejecting \$ref (standing in for a lost lock)" >&2
			    exit 1
			  fi
			done
			exit 0
			HOOK
			    chmod +x "$dir/hooks/pre-receive"
			  fi
			}

			# Gives the bare repo a branch at a known commit, so ls-remote has a
			# tip for the run to compare its own GITHUB_SHA against.
			set_branch_tip() {
			  local origin="$1" branch="$2" work
			  work="$(mktemp -d)"
			  git init --quiet "$work"
			  git -C "$work" config user.email t@example.com
			  git -C "$work" config user.name test
			  git -C "$work" checkout --quiet -b "$branch"
			  echo tip > "$work/tip.txt"
			  git -C "$work" add -A
			  git -C "$work" commit --quiet -m tip
			  git -C "$work" push --quiet "$origin" "$branch"
			  git -C "$work" rev-parse HEAD
			}

			# Pass a version to pin one, or nothing for the auto-increment path
			# the release workflow uses.
			release() {
			  local script="$1" origin="$2" repo="$3" version="${4:-}"
			  rm -rf "$repo"
			  mkdir -p "$repo/payload"
			  echo "content ${version:-auto} $$" > "$repo/payload/file.txt"
			  git init --quiet "$repo"
			  git -C "$repo" config user.email t@example.com
			  git -C "$repo" config user.name test
			  git -C "$repo" checkout --quiet -b master
			  git -C "$repo" add -A
			  git -C "$repo" commit --quiet -m source
			  git -C "$repo" remote add origin "$origin"

			  local args=(--source payload --name widget --message "release ${version:-auto}")
			  [ -n "$version" ] && args+=(--version "$version")
			  [ -n "${INCLUDE_BRANCH:-}" ] && args+=(--include-branch)

			  # BRANCH and SHA let a case stand somewhere other than the tip of
			  # master, which is what decides whether the run publishes #latest.
			  (
			    cd "$repo"
			    export GITHUB_REF_NAME="${BRANCH:-master}" GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=
			    export GITHUB_SHA="${SHA:-}"
			    export GIT_CONFIG_COUNT=1
			    export GIT_CONFIG_KEY_0="url.$origin.insteadOf"
			    export GIT_CONFIG_VALUE_0="$REMOTE_URL"
			    node "$script" "${args[@]}"
			  )
			}

			# Reports whether a ref exists on the remote, by name rather than by
			# a count, so a failure says which ref went missing.
			has_ref() {
			  if git ls-remote --tags "$1" | grep -q "refs/tags/$2\$"; then
			    echo "HAS $2"
			  else
			    echo "MISSING $2"
			  fi
			}

			# A missing ref reads as an empty string, and two empty strings
			# compare equal -- which is how a comparison of two absent tags
			# reports success. Name the absence instead, uniquely, so it can
			# never match anything.
			sha_of() {
			  local sha
			  sha="$(git ls-remote --tags "$1" "refs/tags/$2" | cut -f1)"
			  echo "${sha:-ABSENT:$2}"
			}

tests:
	# The case the whole split exists for. The pointer is refused, the release
	# fails loudly -- and the numbered tag is published anyway.
	- desc: "a refused #latest still leaves the numbered tag published"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git" "refs/tags/widget#latest"
				if release "$SCRIPT" "$work/origin.git" "$work/repo" 7 > "$work/log" 2>&1; then
				  echo "RELEASE_EXIT=0"
				else
				  echo "RELEASE_FAILED_LOUDLY=yes"
				fi
				has_ref "$work/origin.git" 'widget#7'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_FAILED_LOUDLY=yes"
			- "HAS widget#7"

	# The same on the auto-increment path, which is the one the release
	# workflow uses. An empty remote starts the numbering at 1.
	- desc: "auto-increment publishes its numbered tag when #latest is refused"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git" "refs/tags/widget#latest"
				if release "$SCRIPT" "$work/origin.git" "$work/repo" > "$work/log" 2>&1; then
				  echo "RELEASE_EXIT=0"
				else
				  echo "RELEASE_FAILED_LOUDLY=yes"
				fi
				has_ref "$work/origin.git" 'widget#1'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_FAILED_LOUDLY=yes"
			- "HAS widget#1"

	# Nothing refused: both refs land, which is the ordinary release.
	- desc: an uncontested release publishes both refs
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				release "$SCRIPT" "$work/origin.git" "$work/repo" 8 > "$work/log" 2>&1
				echo "RELEASE_EXIT=$?"
				has_ref "$work/origin.git" 'widget#8'
				has_ref "$work/origin.git" 'widget#latest'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_EXIT=0"
			- "HAS widget#8"
			- "HAS widget#latest"

	# The bug this gate exists for. A side branch moved #latest and raced master
	# for the lock, serving its own tree to everyone installing "latest". It
	# publishes its own number and nothing else. Run this suite against the
	# ungated version and it fails here.
	- desc: "a side branch publishes its number and never moves #latest"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				BRANCH=claude/side release "$SCRIPT" "$work/origin.git" "$work/repo" 11 > "$work/log" 2>&1
				echo "RELEASE_EXIT=$?"
				has_ref "$work/origin.git" 'widget#11'
				has_ref "$work/origin.git" 'widget#latest'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_EXIT=0"
			- "HAS widget#11"
			- "MISSING widget#latest"

	# --include-branch is gone. It minted a branch-qualified prefix nothing ever
	# installed, so an unrecognised flag now fails the release rather than
	# publishing a tag under a name no consumer knows.
	- desc: "--include-branch is refused rather than silently ignored"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				if BRANCH=side INCLUDE_BRANCH=1 \
				  release "$SCRIPT" "$work/origin.git" "$work/repo" 14 > "$work/log" 2>&1; then
				  echo "RELEASE_EXIT=0"
				else
				  echo "RELEASE_FAILED_LOUDLY=yes"
				fi
				grep -q 'Unknown option: --include-branch' "$work/log" && echo "NAMED_THE_FLAG"
				has_ref "$work/origin.git" 'widget/side#14'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_FAILED_LOUDLY=yes"
			- "NAMED_THE_FLAG"
			- "MISSING widget/side#14"

	# The same rule applied to one branch over time. Two pushes to master land
	# close together and the older run can finish last; moving the pointer then
	# walks it backwards onto a tree master has already left behind.
	- desc: "a superseded master run publishes its number and never moves #latest"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				set_branch_tip "$work/origin.git" master > /dev/null
				SHA=0000000000000000000000000000000000000000 \
				  release "$SCRIPT" "$work/origin.git" "$work/repo" 12 > "$work/log" 2>&1
				echo "RELEASE_EXIT=$?"
				has_ref "$work/origin.git" 'widget#12'
				has_ref "$work/origin.git" 'widget#latest'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_EXIT=0"
			- "HAS widget#12"
			- "MISSING widget#latest"

	# The control: the run that IS the tip of master still moves the pointer,
	# so the gate did not simply switch #latest off.
	- desc: "the tip of master still moves #latest"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				tip="$(set_branch_tip "$work/origin.git" master)"
				SHA="$tip" release "$SCRIPT" "$work/origin.git" "$work/repo" 13 > "$work/log" 2>&1
				echo "RELEASE_EXIT=$?"
				has_ref "$work/origin.git" 'widget#13'
				has_ref "$work/origin.git" 'widget#latest'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "RELEASE_EXIT=0"
			- "HAS widget#13"
			- "HAS widget#latest"

	# #latest is a pointer and moves; a numbered tag is immutable and does not.
	- desc: "a re-release moves #latest and leaves the older number alone"
	  exit: 0
	  inputs:
		files:
			run.sh: |
				. {shared.lib.sh}
				work="$(mktemp -d)"
				make_origin "$work/origin.git"
				release "$SCRIPT" "$work/origin.git" "$work/repo8" 8 > "$work/log8" 2>&1
				eight="$(sha_of "$work/origin.git" 'widget#8')"
				release "$SCRIPT" "$work/origin.git" "$work/repo9" 9 > "$work/log9" 2>&1
				echo "OLD_NUMBER_UNMOVED=$([ "$eight" = "$(sha_of "$work/origin.git" 'widget#8')" ] && echo yes || echo no)"
				echo "LATEST_FOLLOWS_NEWEST=$([ "$(sha_of "$work/origin.git" 'widget#latest')" = "$(sha_of "$work/origin.git" 'widget#9')" ] && echo yes || echo no)"
				has_ref "$work/origin.git" 'widget#8'
	  cmd: env SCRIPT="$PWD/orphan-release/dist/index.js" bash {inputs.run.sh}
	  outputs:
		stdout:
			- "OLD_NUMBER_UNMOVED=yes"
			- "LATEST_FOLLOWS_NEWEST=yes"
			- "HAS widget#8"
