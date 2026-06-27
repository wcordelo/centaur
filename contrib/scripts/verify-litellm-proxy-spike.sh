#!/usr/bin/env bash
# Verify sandbox → iron-proxy → HTTP LiteLLM after deploying the litellm overlay.
set -euo pipefail

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd kubectl

PROXY_POD="$(kubectl get pods -n "$NAMESPACE" -l centaur.ai/iron-proxy=true -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
SANDBOX_POD="$(kubectl get pods -n "$NAMESPACE" -l centaur.ai/managed=true -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

if [[ -z "$PROXY_POD" || -z "$SANDBOX_POD" ]]; then
  echo "FATAL: need at least one iron-proxy pod and one sandbox pod in namespace $NAMESPACE" >&2
  echo "Start a session (@bot mention or centaur-session-cli) then re-run." >&2
  exit 1
fi

echo "==> Sandbox curl via HTTPS_PROXY to LiteLLM health"
kubectl exec -n "$NAMESPACE" "$SANDBOX_POD" -- sh -c \
  'curl -sf -x "$HTTPS_PROXY" http://centaur-centaur-litellm:4000/health/liveliness'

echo "==> Recent iron-proxy audit lines (expect centaur-centaur-litellm)"
kubectl logs -n "$NAMESPACE" "$PROXY_POD" | grep proxy_audit | tail -5 || {
  echo "WARN: no proxy_audit lines yet"
}

echo "OK"
