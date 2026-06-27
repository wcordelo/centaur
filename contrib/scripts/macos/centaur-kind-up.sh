#!/usr/bin/env bash
# Wait for Docker/kind, then bring up the Centaur Helm stack.
# Used by com.centaur.kind-up.plist on always-on Mac Studio hosts.
set -euo pipefail

REPO_ROOT="${CENTAUR_REPO:-$HOME/Documents/centaur}"
MAX_WAIT_SECS="${CENTAUR_DOCKER_WAIT_SECS:-300}"

log() {
  printf '[centaur-kind-up] %s\n' "$*"
}

deadline=$(( $(date +%s) + MAX_WAIT_SECS ))
until docker info >/dev/null 2>&1; do
  if [[ "$(date +%s)" -ge "$deadline" ]]; then
    log "Docker not ready after ${MAX_WAIT_SECS}s"
    exit 1
  fi
  sleep 5
done

if ! kubectl cluster-info --context kind-centaur >/dev/null 2>&1; then
  log "kind cluster 'centaur' missing; create with: kind create cluster --name centaur"
  exit 1
fi

cd "$REPO_ROOT"
export CENTAUR_EXTRA_VALUES="${CENTAUR_EXTRA_VALUES:-contrib/chart/values.local-slack.example.yaml,contrib/chart/values.litellm.example.yaml}"

log "running just up"
just up

log "done"
