#!/usr/bin/env bash
# Builds two images the core stack runs, locally: the OpenSandbox server, from its pinned commit,
# and the agent runtime every machine runs, from runtime/. Compose builds the orchestrator.
#
#   scripts/images.sh [opensandbox] [runtime]    both when none is named
#
# The OpenSandbox image is tagged by its commit and built once. The runtime image is rebuilt each
# time, from Docker's cache, so a change under runtime/ reaches the next machine.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
opensandbox_commit=473ff611d93670a149ce6600f27ed194b18cce89
opensandbox_image="guilds-opensandbox-server:${opensandbox_commit:0:8}"
runtime_image=agent-runtime:0.4

build_opensandbox() {
  if docker image inspect "$opensandbox_image" >/dev/null 2>&1; then
    return
  fi
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  git init --quiet "$tmp"
  git -C "$tmp" remote add origin https://github.com/opensandbox-group/OpenSandbox.git
  git -C "$tmp" fetch --depth 1 origin "$opensandbox_commit"
  git -C "$tmp" checkout --quiet FETCH_HEAD
  docker build --tag "$opensandbox_image" "$tmp/server"
}

build_runtime() {
  docker build --tag "$runtime_image" "$repo/runtime"
}

if [[ $# -eq 0 ]]; then
  set -- opensandbox runtime
fi
for image in "$@"; do
  case "$image" in
    opensandbox) build_opensandbox ;;
    runtime) build_runtime ;;
    *)
      echo "usage: scripts/images.sh [opensandbox] [runtime]" >&2
      exit 2
      ;;
  esac
done
