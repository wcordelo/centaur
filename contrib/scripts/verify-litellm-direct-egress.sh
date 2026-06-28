#!/usr/bin/env bash
# Verify sandbox → in-cluster LiteLLM direct egress (NO_PROXY path).
# iron-proxy cannot forward plain HTTP to LiteLLM:4000 (CONNECT-only for HTTPS).
set -euo pipefail

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
MODEL="${LITELLM_VERIFY_MODEL:-gemini/gemini-2.5-flash}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd kubectl

SANDBOX_POD="$(kubectl get pods -n "$NAMESPACE" -l centaur.ai/component=session-sandbox -o jsonpath='{.items[-1].metadata.name}' 2>/dev/null || true)"

if [[ -z "$SANDBOX_POD" ]]; then
  echo "FATAL: need at least one sandbox pod (centaur.ai/managed-by=api-rs) in namespace $NAMESPACE" >&2
  echo "Start a session (centaur-session-cli or @bot) then re-run." >&2
  exit 1
fi

echo "==> Sandbox: $SANDBOX_POD"
echo "==> NO_PROXY (expect centaur-centaur-litellm)"
kubectl exec -n "$NAMESPACE" "$SANDBOX_POD" -- printenv NO_PROXY

echo "==> Direct curl to LiteLLM /v1/responses (model=$MODEL)"
kubectl exec -n "$NAMESPACE" "$SANDBOX_POD" -- bash -lc \
  "curl -sf --noproxy '*' \
    -H 'Authorization: Bearer '\$VLLM_API_KEY \
    -H 'Content-Type: application/json' \
    -d '{\"model\":\"${MODEL}\",\"input\":\"Say PONG\"}' \
    http://centaur-centaur-litellm:4000/v1/responses | head -c 300"

echo
echo "==> Recent LiteLLM access log (expect POST /v1/responses)"
kubectl logs -n "$NAMESPACE" deploy/centaur-centaur-litellm --tail=20 2>/dev/null \
  | grep -E 'POST /v1/responses|403|401' | tail -5 || echo "WARN: no matching LiteLLM log lines yet"

echo "OK"
