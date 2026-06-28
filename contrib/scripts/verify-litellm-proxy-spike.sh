#!/usr/bin/env bash
# Verify sandbox → LiteLLM after deploying the litellm overlay.
# In-cluster LiteLLM is reached directly (NO_PROXY); iron-proxy is not in this path.
set -euo pipefail

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
LITELLM_HOST="${CENTAUR_LITELLM_HOST:-centaur-centaur-litellm}"
LITELLM_PORT="${CENTAUR_LITELLM_PORT:-4000}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd kubectl

SANDBOX_POD="$(kubectl get pods -n "$NAMESPACE" -l app.kubernetes.io/name=centaur-sandbox \
  --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.metadata.creationTimestamp}{"\t"}{.metadata.name}{"\n"}{end}' 2>/dev/null \
  | sort -r | head -1 | cut -f2- || true)"

if [[ -z "$SANDBOX_POD" ]]; then
  echo "FATAL: need at least one sandbox pod in namespace $NAMESPACE" >&2
  echo "Start a session (@bot mention or centaur-session-cli) then re-run." >&2
  exit 1
fi

echo "==> Sandbox direct curl to LiteLLM health (bypasses iron-proxy)"
kubectl exec -n "$NAMESPACE" "$SANDBOX_POD" -- sh -c \
  "curl -sf --max-time 10 http://${LITELLM_HOST}:${LITELLM_PORT}/health/liveliness"

echo "==> Sandbox NO_PROXY includes LiteLLM host"
kubectl exec -n "$NAMESPACE" "$SANDBOX_POD" -- sh -c \
  'case ",${NO_PROXY:-${no_proxy:-}}," in *,'"${LITELLM_HOST}"',*) exit 0 ;; *) echo "NO_PROXY missing '"${LITELLM_HOST}"'"; exit 1 ;; esac'

echo "OK"
