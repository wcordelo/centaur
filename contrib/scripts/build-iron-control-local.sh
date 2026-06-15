#!/usr/bin/env bash
# Build a native iron-control image for Apple Silicon / arm64 kind clusters.
#
# Upstream publishes linux/amd64 only (ironsh/iron-control:latest). api-rs
# requires iron-control when iron-proxy is enabled, so local v2 Slack dev on
# arm64 Macs needs this one-time build.
#
# Usage:
#   contrib/scripts/build-iron-control-local.sh
#   kind load docker-image iron-control:local-arm64 --name centaur
set -euo pipefail

TAG="${IRON_CONTROL_LOCAL_TAG:-local-arm64}"
IMAGE="iron-control:${TAG}"
CLONE_DIR="${IRON_CONTROL_CLONE_DIR:-${TMPDIR:-/tmp}/iron-control-build}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd docker
require_cmd git

if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "==> Cloning iron-control into $CLONE_DIR"
  git clone --depth 1 https://github.com/ironsh/iron-control.git "$CLONE_DIR"
else
  echo "==> Updating existing clone at $CLONE_DIR"
  git -C "$CLONE_DIR" pull --ff-only
fi

echo "==> Building $IMAGE (native platform)"
docker build -t "$IMAGE" "$CLONE_DIR"

echo ""
echo "Done. Load into kind (adjust cluster name if needed):"
echo "  kind load docker-image $IMAGE --name \${KIND_CLUSTER_NAME:-centaur}"
echo ""
echo "The local Slack overlay expects repository: iron-control, tag: ${TAG}"
