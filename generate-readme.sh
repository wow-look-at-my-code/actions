#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

cat <<'HEADER'
# GitHub Actions

Reusable GitHub Actions.

## Building

Every node action builds with [ts0](https://github.com/wow-look-at-my/ts0), from the `ts0.json` in its directory: `cd <action> && just build`. Get ts0 with `curl -fsSL https://apt.pazer.build/ts0/install.sh | sudo sh && sudo apt-get install ts0`. CI downloads it from buildhost instead.

ts0 supplies the compiler, the bundler and `@types/node`, so an action's `package.json` lists only what it imports at run time. `ts0 test` type-checks the project and runs its test files. `dist/` is not committed. CI builds it before it cuts a release tag.

## Actions
HEADER

while IFS= read -r action_yml; do
  dir=$(dirname "$action_yml")
  name=$(yq -r '.name' "$action_yml")
  desc=$(yq -r '.description' "$action_yml")

  echo ""
  echo "### [$name]($dir/)"
  echo ""
  echo '```yml'

  echo "# $desc."
  if [ -f "$dir/README.md" ]; then
    echo "# Docs: https://raw.githubusercontent.com/wow-look-at-my/actions/refs/heads/master/$dir/README.md"
  fi
  echo "- uses: wow-look-at-my/actions@${dir}#latest"

  # Get required inputs as newline-separated keys
  required_keys=$(yq -r '.inputs // {} | to_entries[] | select(.value.required == true) | .key' "$action_yml")

  if [ -n "$required_keys" ]; then
    echo "  with:"
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      desc_input=$(yq -r ".inputs.\"$key\".description" "$action_yml")
      echo "    $key: # $desc_input"
    done <<< "$required_keys"
  fi

  echo '```'
done < <(find . -name action.yml -not -path './.github/*' -not -path '*/test/*' | sed 's|^\./||' | sort)

# Reusable workflows (workflow_call triggers in .github/workflows/)
first_wf=true
while IFS= read -r wf; do
  grep -q 'workflow_call' ".github/workflows/$wf" || continue

  if $first_wf; then
    echo ""
    echo "## Reusable Workflows"
    first_wf=false
  fi

  name=$(yq -r '.name' ".github/workflows/$wf")

  echo ""
  echo "### $name"
  echo ""
  echo '```yml'
  echo "jobs:"
  echo "  ${wf%.yml}:"
  echo "    uses: wow-look-at-my/actions/.github/workflows/${wf}@master"
  echo '```'
  extra=".github/workflows/${wf%.yml}.md"
  if [ -f "$extra" ]; then
    echo ""
    cat "$extra"
  fi
done < <(find .github/workflows -maxdepth 1 -name '*.yml' | sed 's|.*/||' | sort)
