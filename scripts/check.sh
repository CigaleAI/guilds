#!/usr/bin/env bash
# The whole check, with its own throwaway Postgres. The verify workflow runs this script, so a push
# that passes it here reaches CI already passing.
#
#   scripts/check.sh           checks the working tree as it is
#   scripts/check.sh <commit>  checks that commit the way CI does: a clean checkout of it and a
#                              frozen install. A commit that passes is remembered and not re-run.
#
# The orchestrator, web, and core-stack lanes run side by side. Each step logs to its own file; a
# failing step prints its log.
#
# An edition on top of core holds core in a subdirectory and runs this script with EDITION_ROOT set
# to its own root. The checkout, the install and every step then happen in that root, with core at
# the commit the edition pins, and the edition's check.steps adds steps, one per line: the lane it
# joins (orchestrator or web), a name, and the command.
set -euo pipefail

core="$(cd "$(dirname "$0")/.." && pwd -P)"
repo="$(cd "${EDITION_ROOT:-$core}" && pwd -P)"
# Core's path under the root the check runs in: `.` when that root is core itself.
core_path="${core#"$repo"}"
core_path="${core_path#/}"
core_path="${core_path:-.}"
passed="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/check-passed"
work="$(mktemp -d "${TMPDIR:-/tmp}/guilds-check.XXXXXX")"
tree="$repo"
commit=""
postgres=""

cleanup() {
  if [[ -n "$postgres" ]]; then docker rm -f "$postgres" >/dev/null 2>&1 || true; fi
  if [[ "$tree" != "$repo" ]]; then
    if [[ "$core" != "$repo" ]]; then git -C "$core" worktree remove --force "$tree/$core_path" >/dev/null 2>&1 || true; fi
    git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1 || true
  fi
  # A container's files can belong to another user on Linux; removing them is not part of the check.
  rm -rf "$work" 2>/dev/null || docker run --rm --volume "$work:/work" postgres:17 sh -c 'rm -rf /work/*' >/dev/null 2>&1 || true
  rm -rf "$work" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ $# -gt 0 ]]; then
  commit="$(git -C "$repo" rev-parse --verify "$1^{commit}")"
  if [[ -f "$passed" ]] && grep -qx "$commit" "$passed"; then
    echo "check: $(git -C "$repo" log -1 --format='%h %s' "$commit") already passed"
    exit 0
  fi
  echo "check: $(git -C "$repo" log -1 --format='%h %s' "$commit")"
  tree="$work/tree"
  git -C "$repo" worktree add --detach --quiet "$tree" "$commit"
  if [[ "$core" != "$repo" ]]; then
    # The edition's commit names core's; this checkout of core has it without asking a remote.
    rmdir "$tree/$core_path"
    git -C "$core" worktree add --detach --quiet "$tree/$core_path" "$(git -C "$repo" rev-parse "$commit:$core_path")"
  fi
  if ! (cd "$tree" && pnpm install --frozen-lockfile --prefer-offline) >"$work/install.log" 2>&1; then
    echo "✗ pnpm install --frozen-lockfile"
    cat "$work/install.log"
    exit 1
  fi
else
  echo "check: working tree"
fi

postgres="guilds-check-$$"
docker run --detach --rm --name "$postgres" \
  --env POSTGRES_DB=agent_platform \
  --env POSTGRES_USER=agent_platform \
  --env POSTGRES_PASSWORD=agent_platform \
  --publish 127.0.0.1::5432 \
  --tmpfs /var/lib/postgresql/data \
  postgres:17 >/dev/null
until docker exec "$postgres" pg_isready -q -h 127.0.0.1 -U agent_platform -d agent_platform; do
  sleep 0.5
done
port="$(docker port "$postgres" 5432/tcp | head -n 1 | sed 's/.*://')"

export R1_ADMIN_DATABASE_URL="postgresql://agent_platform:agent_platform@127.0.0.1:${port}/postgres"
export STATE_ROOT="$work/state"
export POSTGRES_PASSWORD=agent_platform
export OPENSANDBOX_API_KEY=guilds-dev
mkdir -p "$STATE_ROOT/workspaces" "$STATE_ROOT/opensandbox" "$STATE_ROOT/notes"

step() {
  local name="$1"
  shift
  local log="$work/$name.log"
  local started=$SECONDS
  if (cd "$tree" && "$@") >"$log" 2>&1; then
    echo "✓ $name ($((SECONDS - started))s)"
  else
    echo "✗ $name ($((SECONDS - started))s)"
    sed 's/^/  │ /' "$log"
    return 1
  fi
}

edition_steps() {
  local lane="$1" step_lane name command
  [[ "$core" != "$repo" && -f "$tree/check.steps" ]] || return 0
  while read -r step_lane name command; do
    [[ "$step_lane" == "$lane" ]] || continue
    step "$name" bash -c "$command" || return 1
  done <"$tree/check.steps"
}

orchestrator_lane() {
  step typecheck pnpm -r typecheck &&
    step lint pnpm -r lint &&
    step compat-verify pnpm --filter @guildsrun/orchestrator compat:verify &&
    step test-orchestrator pnpm --filter @guildsrun/orchestrator test &&
    step test-docs-mcp pnpm --filter @guildsrun/docs-mcp test &&
    edition_steps orchestrator
}

web_lane() {
  step test-ui pnpm --filter @guildsrun/ui test &&
    step test-web pnpm --filter @guildsrun/web test &&
    step build-web pnpm --filter @guildsrun/web build &&
    step build-storybook pnpm --filter @guildsrun/ui build-storybook &&
    edition_steps web
}

stack_lane() {
  step smoke-core-stack "$core_path/scripts/smoke-core-stack.sh"
}

started=$SECONDS
orchestrator_lane &
orchestrator=$!
web_lane &
web=$!
stack_lane &
stack=$!
status=0
wait "$orchestrator" || status=1
wait "$web" || status=1
wait "$stack" || status=1

if [[ $status -ne 0 ]]; then
  echo "check failed ($((SECONDS - started))s)"
  exit 1
fi
if [[ -n "$commit" ]]; then echo "$commit" >>"$passed"; fi
echo "check passed ($((SECONDS - started))s)"
