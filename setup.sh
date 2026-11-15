#!/usr/bin/env bash
# Prepares this checkout to run the core stack with `docker compose up`.
#
# It writes into .env what the stack cannot start without and nobody should pick by hand: the
# absolute path the stack keeps its state under, the master key that encrypts stored credentials,
# the PostgreSQL password, and the OpenSandbox key. It refuses a state path on a filesystem the
# stack cannot run on, creates the state directories, and builds the two images the stack runs
# under local tags: the OpenSandbox server and the agent runtime.
#
#   ./setup.sh               everything
#   ./setup.sh --env-only    .env and the state directories; no image is built
#
# Running it again is safe: a value .env already has is kept.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
env_file="$root/.env"
build_images=1

for arg in "$@"; do
  case "$arg" in
    --env-only) build_images=0 ;;
    -h | --help)
      sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see ./setup.sh --help)" >&2
      exit 2
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH: the stack runs in Docker" >&2
  exit 1
fi

# The value .env gives a variable, without quotes; empty when it has none.
value_of() {
  local line
  line="$(grep -E "^$1=" "$env_file" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"
  line="${line#\"}"
  line="${line%\'}"
  line="${line#\'}"
  printf '%s' "$line"
}

# Gives a variable its value in .env: in place when .env names it, at the end otherwise.
set_value() {
  local name="$1" value="$2" tmp
  if grep -qE "^$name=" "$env_file"; then
    tmp="$(mktemp)"
    awk -v name="$name" -v value="$value" '
      !done && index($0, name "=") == 1 { print name "=" value; done = 1; next }
      { print }
    ' "$env_file" >"$tmp"
    cat "$tmp" >"$env_file"
    rm -f "$tmp"
  else
    printf '%s=%s\n' "$name" "$value" >>"$env_file"
  fi
}

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$1"
  else
    head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

if [[ ! -f "$env_file" ]]; then
  (umask 077 && cp "$root/.env.example" "$env_file")
  echo "created .env from .env.example"
fi

state_root="$(value_of STATE_ROOT)"
if [[ -z "$state_root" ]]; then
  state_root="$root/.state"
  set_value STATE_ROOT "$state_root"
  echo "STATE_ROOT set to $state_root"
fi
if [[ "$state_root" != /* ]]; then
  echo "STATE_ROOT must be an absolute path (OpenSandbox mounts workspaces by it); .env has: $state_root" >&2
  exit 1
fi

# PostgreSQL and the agent machines keep their files in directories of STATE_ROOT that Docker
# mounts into their containers. A filesystem this host reads and writes without trouble can still
# fail through that mount, so what they rely on is tried from a container, where they run.
mkdir -p "$state_root"
probe_status=0
probe_output="$(
  docker run --rm --interactive --volume "$state_root:/state" postgres:17 sh -s 2>&1 <<'PROBE'
refuse() {
  echo "unusable: $1"
  exit 1
}
dir=/state/.setup-probe
rm -rf "$dir"
mkdir "$dir" || refuse "create a directory"
trap 'rm -rf "$dir"' EXIT
cd "$dir" || refuse "enter a directory it created"
echo probe >written && [ "$(cat written)" = probe ] || refuse "read back a file it wrote"
mv written renamed && [ "$(cat renamed)" = probe ] || refuse "read a file after renaming it"
chmod 700 . && [ "$(stat -c %a .)" = 700 ] || refuse "restrict a directory to its owner"
chown 999:999 renamed && [ "$(stat -c %u:%g renamed)" = 999:999 ] || refuse "change the owner of a file"
ln renamed linked || refuse "hard-link a file"
ln -s renamed symlinked && [ "$(cat symlinked)" = probe ] || refuse "read a file through a symbolic link"
printf '#!/bin/sh\nexit 0\n' >script && chmod 755 script && ./script || refuse "run a script it wrote"
PROBE
)" || probe_status=$?
if [[ "$probe_output" == *"unusable: "* ]]; then
  echo "STATE_ROOT is on a filesystem the stack cannot run on: under $state_root a container could not ${probe_output##*unusable: }." >&2
  echo "PostgreSQL and the agent machines keep their files there and need a Unix filesystem: ownership, permissions, links, and a file that is there once written. Point STATE_ROOT in .env at a directory on one." >&2
  exit 1
fi
if [[ $probe_status -ne 0 ]]; then
  echo "could not check the filesystem under STATE_ROOT ($state_root) from a container:" >&2
  echo "$probe_output" >&2
  exit 1
fi

# A database that already exists was created with a password, and its credentials were encrypted
# with a key, that only whoever created it has. Generating new ones would lock it.
postgres_dir="$state_root/postgres"
existing_state=0
if [[ -d "$postgres_dir" && -n "$(ls -A "$postgres_dir" 2>/dev/null || echo unreadable)" ]]; then
  existing_state=1
fi
missing=()
for name in SECRETS_MASTER_KEY POSTGRES_PASSWORD OPENSANDBOX_API_KEY; do
  if [[ -z "$(value_of "$name")" ]]; then
    missing+=("$name")
  fi
done
if [[ ${#missing[@]} -gt 0 && $existing_state -eq 1 ]]; then
  echo "$postgres_dir already holds a database, and .env has no ${missing[*]}." >&2
  echo "Put the values that database was created with into .env, or point STATE_ROOT at an empty directory." >&2
  exit 1
fi
for name in ${missing[@]+"${missing[@]}"}; do
  case "$name" in
    SECRETS_MASTER_KEY) set_value "$name" "$(random_hex 32)" ;;
    *) set_value "$name" "$(random_hex 24)" ;;
  esac
  echo "$name generated"
done

mkdir -p "$state_root/notes" "$state_root/workspaces" "$state_root/attachments" \
  "$state_root/connectors" "$state_root/postgres" "$state_root/opensandbox"

if [[ $build_images -eq 1 ]]; then
  "$root/scripts/images.sh"
fi

port="$(value_of ORCHESTRATOR_PORT)"
cat <<DONE

Ready. Start the stack:

  docker compose up --detach --wait

Then open http://127.0.0.1:${port:-8080}/

Keep .env: SECRETS_MASTER_KEY is the only copy of the key your stored credentials are encrypted
with. Platform keys (the GitHub App, the Google OAuth client, web search, System One) are
entered under Admin, Platform keys once the stack is up.
DONE
