#!/usr/bin/env bash
# Starts the core stack the way a new self-hoster does, from a copy of this checkout, and checks
# what the stack promises: ./setup.sh then `docker compose up` gives a healthy box that serves the
# operator app on loopback only, holds one operator and no hosted table, and refuses a request
# from another web origin; and a container on the default bridge, where OpenSandbox starts every
# sandbox, reaches the MCP server's port at the URL sandboxes are given, is refused there without a
# token, and does not reach the operator app's port by the same host.
#
# It runs under its own Compose project, ports, image tag and state directory, and removes them
# when it ends, so it never touches a stack or an .env of yours. The agent runtime images are not
# built: no sandbox starts, and a PostgreSQL container on the bridge stands in for one.
#
#   scripts/smoke-core-stack.sh
set -euo pipefail

# A new self-hoster's shell sets nothing the stack reads, and neither does this test's: the stack
# takes its values from the .env setup writes, and its state from the copy's own directory.
unset STATE_ROOT POSTGRES_PASSWORD OPENSANDBOX_API_KEY SECRETS_MASTER_KEY SANDBOX_IMAGE AUTH_MODE SENTRY_ENVIRONMENT \
  HARNESS_MCP_PUBLISH HARNESS_MCP_SANDBOX_HOST HARNESS_MCP_URL

repo="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d "${TMPDIR:-/tmp}/guilds-smoke.XXXXXX")"
work="$(cd "$work" && pwd -P)"
project="guilds-smoke-$$"
export ORCHESTRATOR_IMAGE="guilds-smoke-$$:local"
export ORCHESTRATOR_PORT="${SMOKE_PORT:-18080}"
export HARNESS_MCP_PORT="${SMOKE_MCP_PORT:-$((ORCHESTRATOR_PORT + 1))}"
base="http://127.0.0.1:${ORCHESTRATOR_PORT}"
compose=(docker compose --project-name "$project")

cleanup() {
  status=$?
  if [[ $status -ne 0 && -f "$work/tree/docker-compose.yml" ]]; then
    (cd "$work/tree" && "${compose[@]}" logs --tail 40 orchestrator 2>/dev/null) || true
  fi
  if [[ -f "$work/tree/.env" ]]; then
    (cd "$work/tree" && "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1) || true
  fi
  docker image rm "$ORCHESTRATOR_IMAGE" >/dev/null 2>&1 || true
  # PostgreSQL's files can belong to another user on Linux.
  rm -rf "$work" 2>/dev/null || docker run --rm --volume "$work:/work" postgres:17 rm -rf /work/tree >/dev/null 2>&1 || true
  rm -rf "$work" 2>/dev/null || true
  exit $status
}
trap cleanup EXIT

fail() {
  echo "smoke: $*" >&2
  exit 1
}

# A copy of the checkout as git sees it: tracked files and new ones, nothing ignored.
mkdir "$work/tree"
(cd "$repo" && git ls-files -co --exclude-standard -z | tar --null -T - -cf - 2>/dev/null) | tar -xf - -C "$work/tree"
cd "$work/tree"

if "${compose[@]}" config >/dev/null 2>"$work/config.err"; then
  fail "the stack resolved without ./setup.sh; it must ask for it"
fi
grep -q "run ./setup.sh first" "$work/config.err" || fail "the stack did not say to run ./setup.sh: $(tail -n 1 "$work/config.err")"

./setup.sh --env-only >/dev/null
[[ "$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env)" == "600" ]] || fail ".env is readable by others"
before="$(cksum <.env)"
./setup.sh --env-only >/dev/null
[[ "$before" == "$(cksum <.env)" ]] || fail "a second ./setup.sh changed .env"
"$repo/scripts/images.sh" opensandbox

"${compose[@]}" up --detach --wait >"$work/up.log" 2>&1 || {
  cat "$work/up.log" >&2
  fail "the stack did not come up healthy"
}

json() { # path, python expression over the parsed body `d`
  curl -fsS "$base$1" | python3 -c "import json, sys; d = json.load(sys.stdin); print($2)"
}

[[ "$(curl -fsS "$base/health" | python3 -c 'import json, sys; print(json.load(sys.stdin).get("status", ""))')" != "" ]] || fail "/health did not answer"
curl -fsS -H "Accept: text/html" "$base/" | grep -q 'id="root"' || fail "the operator app is not served at /"
[[ "$(json /api/users '[u["name"] for u in d]')" == "['operator']" ]] || fail "the box does not hold exactly the operator"
[[ "$(json /api/instance 'd["auth_mode"]')" == "compat-cookie" ]] || fail "the box is not in compat-cookie mode"
# The registry reads its default URL with no key set; every other integration needs one.
[[ "$(json /api/instance 'sorted(i["id"] for i in d["integrations"] if i["state"] != "off")')" == "['registry']" ]] || fail "an integration other than the registry is on with no key set"
created="$(curl -fsS -H "Content-Type: application/json" -d '{"name":"smoke"}' "$base/api/guilds" | python3 -c 'import json, sys; print(json.load(sys.stdin)["id"])')"
[[ "$created" == guild_* ]] || fail "a guild could not be created"
refused="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Origin: https://elsewhere.example" -H "Content-Type: application/json" -d '{"name":"x"}' "$base/api/guilds")"
[[ "$refused" == "403" ]] || fail "a request from another origin answered $refused, not 403"

publish="$(grep -E '^HARNESS_MCP_PUBLISH=' .env | cut -d= -f2-)"
[[ -n "$publish" ]] || fail "./setup.sh wrote no HARNESS_MCP_PUBLISH"
ports="$("${compose[@]}" ps --format '{{.Ports}}' | grep -o '[0-9.:]*->[0-9]*' | sort -u | tr '\n' ' ')"
expected="$(printf '%s\n' "127.0.0.1:${ORCHESTRATOR_PORT}->8080" "${publish}:${HARNESS_MCP_PORT}->${HARNESS_MCP_PORT}" | sort -u | tr '\n' ' ')"
[[ "$ports" == "$expected" ]] || fail "published ports are '$ports', not the operator app on loopback and the MCP port on $publish alone"

# A container on the default bridge, as OpenSandbox starts a sandbox, sends one request to
# host:port and prints the status line of the answer, or `refused` when nothing answers there.
from_sandbox() { # host, port, method, path, body
  docker run --rm --network bridge postgres:17 bash -c '
    exec 3<>"/dev/tcp/$1/$2" 2>/dev/null || { echo refused; exit 0; }
    printf "%s %s HTTP/1.1\r\nHost: %s:%s\r\nContent-Type: application/json\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s" \
      "$3" "$4" "$1" "$2" "${#5}" "$5" >&3
    timeout 5 head -n 1 <&3 | tr -d "\r"' probe "$@"
}
mcp_url="$("${compose[@]}" exec -T orchestrator printenv HARNESS_MCP_URL)"
[[ "$mcp_url" =~ ^http://([^/:]+):([0-9]+)$ ]] || fail "the URL sandboxes are given is '$mcp_url'"
mcp_host="${BASH_REMATCH[1]}"
[[ "${BASH_REMATCH[2]}" == "$HARNESS_MCP_PORT" ]] || fail "the URL sandboxes are given, $mcp_url, is not on the published port"
initialize='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
[[ "$(from_sandbox "$mcp_host" "$HARNESS_MCP_PORT" GET /health "")" == "HTTP/1.1 200 OK" ]] || fail "a sandbox does not reach the MCP port at $mcp_url"
[[ "$(from_sandbox "$mcp_host" "$HARNESS_MCP_PORT" POST /mcp/agent_smoke "$initialize")" == "HTTP/1.1 401 Unauthorized" ]] || fail "the MCP server answered a sandbox without a token"
[[ "$(from_sandbox "$mcp_host" "$HARNESS_MCP_PORT" GET /api/guilds "")" == "HTTP/1.1 404 Not Found" ]] || fail "the MCP port serves the API"
api="$(from_sandbox "$mcp_host" "$ORCHESTRATOR_PORT" GET /health "")"
if [[ "$(docker info --format '{{.OperatingSystem}}')" == "Docker Desktop" ]]; then
  # Docker Desktop forwards host.docker.internal to the host's loopback, where the operator app is
  # published (SEC-63).
  echo "smoke: on Docker Desktop a sandbox reaches the operator app's port by the same host: $api" >&2
else
  [[ "$api" == "refused" ]] || fail "a sandbox reaches the operator app's port at $mcp_host: $api"
fi
tables="$("${compose[@]}" exec -T postgres psql -U agent_platform -d agent_platform -At -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('plans', 'sessions', 'org_subscriptions', 'sandbox_hosts', '__hosted_migrations')")"
[[ "$tables" == "0" ]] || fail "the core database holds $tables hosted tables"
mounts="$(docker inspect "$("${compose[@]}" ps --quiet orchestrator)" --format '{{range .Mounts}}{{.Destination}} {{end}}')"
[[ "$mounts" != */app/* ]] || fail "the orchestrator has source mounted over its image: $mounts"

echo "smoke: the core stack came up from ./setup.sh and docker compose up, and behaves as shipped"
