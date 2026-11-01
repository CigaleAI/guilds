#!/usr/bin/env bash
# Serves this checkout's stack as a preview: at the random trycloudflare.com hostname of a Cloudflare
# quick tunnel, behind the password Caddy asks for (docker-compose.preview.yml), with the operator,
# a model provider on the given key, its model as the organisation's default, a guild and an agent
# seeded.
#
# It runs a copy of this checkout under its own Compose project, port, image tag and state
# directory, all named by the port, so it never touches a stack or an .env of yours. `up` replaces
# a preview already up on the same port and prints one line, the preview's URL. `down` removes the
# preview: its containers, its image and its state directory.
#
#   scripts/preview-stack.sh up
#   scripts/preview-stack.sh down
#
# `up` reads:
#   PREVIEW_PASSWORD       required; the password of the user `preview`. Only its bcrypt hash is written
#   PREVIEW_MODEL_KEY      required; the model provider's key, sent to the box and written to no file
#   PREVIEW_MODEL          required; a {provider}/{model} id, the provider being the part before the first slash
#   PREVIEW_RUNTIME_IMAGE  the agent runtime image, pulled; ghcr.io/cigaleai/guilds-agent-runtime:latest by default
#   PREVIEW_PORT           the orchestrator's loopback port; 18090 by default. `down` reads it too
set -euo pipefail

# The stack takes its values from the copy's .env, never from the caller's shell or a Makefile's exports.
unset STATE_ROOT POSTGRES_PASSWORD OPENSANDBOX_API_KEY SECRETS_MASTER_KEY SANDBOX_IMAGE AUTH_MODE \
  SENTRY_ENVIRONMENT PUBLIC_BASE_URL

repo="$(cd "$(dirname "$0")/.." && pwd)"
port="${PREVIEW_PORT:-18090}"
runtime_image="${PREVIEW_RUNTIME_IMAGE:-ghcr.io/cigaleai/guilds-agent-runtime:latest}"
project="guilds-preview-$port"
# A physical path: OpenSandbox mounts workspaces by the path the host gives them.
state="$(cd "${TMPDIR:-/tmp}" && pwd -P)/$project"
tree="$state/tree"
hash_file="scripts/preview/.caddy-hash"
export ORCHESTRATOR_IMAGE="$project:local"
export ORCHESTRATOR_PORT="$port"
base="http://127.0.0.1:$port"
compose=(docker compose --project-name "$project" -f docker-compose.yml -f docker-compose.preview.yml)

fail() {
  echo "preview: $*" >&2
  exit 1
}

remove_preview() {
  if [[ -f "$tree/.env" ]]; then
    (cd "$tree" && "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  docker image rm "$ORCHESTRATOR_IMAGE" >/dev/null 2>&1 || true
  rm -f "$tree/$hash_file"
  # PostgreSQL's files can belong to another user on Linux.
  rm -rf "$state" 2>/dev/null || docker run --rm --volume "$state:/state" postgres:17 rm -rf /state/tree >/dev/null 2>&1 || true
  rm -rf "$state" 2>/dev/null || true
}

# A failed `up` shows the services' last lines and leaves nothing behind.
remove_failed_preview() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    if [[ -f "$tree/.env" ]]; then
      (cd "$tree" && "${compose[@]}" logs --tail 40 orchestrator caddy cloudflared >&2 2>/dev/null) || true
    fi
    remove_preview
  fi
  exit $status
}

# Gives a variable its value in .env, which keeps the mode setup gave it.
set_env() {
  local others
  others="$(grep -v "^$1=" .env || true)"
  printf '%s\n%s=%s\n' "$others" "$1" "$2" >.env
}

# A curl config that names the preview's user and password, read on stdin, so the password is on no
# command line.
credentials_config() {
  local password="${PREVIEW_PASSWORD//\\/\\\\}"
  password="${password//\"/\\\"}"
  printf 'user = "preview:%s"\n' "$password"
}

# The `id` of the JSON object or first array item on stdin.
id_of() {
  python3 -c 'import json, sys; d = json.load(sys.stdin); print((d[0] if isinstance(d, list) else d)["id"])'
}

up() {
  for name in PREVIEW_PASSWORD PREVIEW_MODEL_KEY PREVIEW_MODEL; do
    [[ -n "${!name:-}" ]] || fail "$name is required"
  done
  local provider="${PREVIEW_MODEL%%/*}"
  [[ -n "$provider" && "$PREVIEW_MODEL" == "$provider"/?* ]] || fail "PREVIEW_MODEL must be a {provider}/{model} id"
  export PREVIEW_MODEL_KEY PREVIEW_MODEL

  remove_preview
  trap remove_failed_preview EXIT
  mkdir -p "$tree"
  # A copy of the checkout as git sees it: tracked files and new ones, nothing ignored.
  (cd "$repo" && git ls-files -co --exclude-standard -z | tar --null -T - -cf - 2>/dev/null) | tar -xf - -C "$tree"
  cd "$tree"

  [[ -f .env ]] || ./setup.sh --env-only >/dev/null
  scripts/images.sh opensandbox >&2
  # Pulled, not built: building Chromium into the runtime takes longer than a preview lasts. Only
  # a machine starting needs it, so the preview comes up without it.
  if ! docker pull --quiet "$runtime_image" >/dev/null 2>"$state/pull.log"; then
    echo "preview: $runtime_image could not be pulled, so no agent machine can start: $(tail -n 1 "$state/pull.log")" >&2
  fi
  set_env SANDBOX_IMAGE "$runtime_image"

  local caddy_image
  caddy_image="$("${compose[@]}" config --format json | python3 -c 'import json, sys; print(json.load(sys.stdin)["services"]["caddy"]["image"])')"
  (umask 077 && printf '%s\n' "$PREVIEW_PASSWORD" | docker run --rm -i "$caddy_image" caddy hash-password >"$hash_file")
  [[ -s "$hash_file" ]] || fail "Caddy did not hash the password"

  # The orchestrator serves only loopback hosts and PUBLIC_BASE_URL's, and the tunnel forwards its
  # own hostname, so the tunnel comes up first and names the URL the orchestrator starts with.
  "${compose[@]}" up --detach cloudflared >"$state/up.log" 2>&1 || {
    cat "$state/up.log" >&2
    fail "the tunnel did not start"
  }
  local url=""
  for _ in $(seq 60); do
    url="$("${compose[@]}" logs cloudflared 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | grep -v '^https://api\.' | head -n 1 || true)"
    [[ -z "$url" ]] || break
    sleep 1
  done
  [[ -n "$url" ]] || fail "the cloudflared log named no trycloudflare.com URL within 60 seconds"
  set_env PUBLIC_BASE_URL "$url"

  "${compose[@]}" up --detach --wait --build --no-recreate >"$state/up.log" 2>&1 || {
    cat "$state/up.log" >&2
    fail "the stack did not come up healthy"
  }

  # Seeded over loopback, where compat-cookie mode makes the caller the operator.
  local org guild status
  org="$(curl -fsS "$base/api/orgs" | id_of)" || fail "the operator's organisation could not be read"
  status="$(python3 -c 'import json, os; print(json.dumps({"api_key": os.environ["PREVIEW_MODEL_KEY"], "models": [os.environ["PREVIEW_MODEL"]]}))' |
    curl -sS -o "$state/connect.json" -w '%{http_code}' -X PUT -H "Content-Type: application/json" --data-binary @- \
      "$base/api/orgs/$org/model-providers/$provider")"
  guild="$(curl -fsS -H "Content-Type: application/json" -d '{"name":"preview"}' "$base/api/guilds" | id_of)" ||
    fail "the preview guild could not be created"
  # A refused key leaves a preview to look at; only a run needs the model.
  if [[ "$status" != "200" ]]; then
    echo "preview: $provider refused the connection ($status: $(cat "$state/connect.json")), so the preview has no model and no agent" >&2
  else
    python3 -c 'import json, os; print(json.dumps({"model": os.environ["PREVIEW_MODEL"]}))' |
      curl -fsS -o /dev/null -X PUT -H "Content-Type: application/json" --data-binary @- "$base/api/orgs/$org/default-model" ||
      fail "$PREVIEW_MODEL could not be made the default model"
    python3 -c 'import json, os; print(json.dumps({"name": "preview", "config": {"model": os.environ["PREVIEW_MODEL"]}, "focus": "Tries the pull request this preview serves."}))' |
      curl -fsS -o /dev/null -H "Content-Type: application/json" --data-binary @- "$base/api/guilds/$guild/agents" ||
      fail "the preview agent could not be created"
  fi

  # From outside: the tunnel's hostname can take a while to resolve.
  local code=""
  for _ in $(seq 90); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$url/" 2>/dev/null || true)"
    [[ "$code" != "401" ]] || break
    sleep 1
  done
  [[ "$code" == "401" ]] || fail "$url answered $code without the password, not 401"
  local page
  page="$(credentials_config | curl -fsS --config - -H "Accept: text/html" "$url/")" || fail "$url refused the password"
  [[ "$page" == *'id="root"'* ]] || fail "$url does not serve the operator app"

  echo "$url"
}

down() {
  remove_preview
  [[ ! -e "$state" ]] || fail "$state could not be removed"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *)
    echo "usage: scripts/preview-stack.sh up|down" >&2
    exit 2
    ;;
esac
