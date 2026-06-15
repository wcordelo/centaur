#!/usr/bin/env bash
# Quick health check for local Centaur + Slack (kind/k3s/laptop clusters).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/slack-stack.sh
source "$SCRIPT_DIR/../lib/slack-stack.sh"

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
RELEASE="${CENTAUR_RELEASE:-centaur}"
PORT="${CENTAUR_SLACKBOT_LOCAL_PORT:-3001}"
FAIL=0

check() {
  local name="$1"
  shift
  if "$@"; then
    echo "OK   $name"
  else
    echo "FAIL $name"
    FAIL=1
  fi
}

echo "==> Kubernetes context"
kubectl config current-context

echo ""
echo "==> Core pods"
kubectl get pods -n "$NAMESPACE" \
  -l "app.kubernetes.io/instance=${RELEASE}" 2>/dev/null \
  | grep -E 'api-rs|slackbot|postgres|agent-sandbox' || kubectl get pods -n "$NAMESPACE"

echo ""
STACK="$(centaur_slack_stack_label 2>/dev/null || echo unknown)"
echo "==> Slack stack: $STACK"

echo ""
echo "==> In-cluster health"
if kubectl -n "$NAMESPACE" get "deployment/${RELEASE}-centaur-api-rs" >/dev/null 2>&1; then
  check "api-rs ready" sh -c "test \"\$(kubectl -n \"$NAMESPACE\" get \"deployment/${RELEASE}-centaur-api-rs\" -o jsonpath='{.status.readyReplicas}')\" = \"1\""
  check "agent-sandbox CRDs" kubectl get crd sandboxes.agents.x-k8s.io >/dev/null 2>&1
  check "agent-sandbox controller" sh -c \
    "test \"\$(kubectl -n agent-sandbox-system get deploy/agent-sandbox-controller -o jsonpath='{.status.readyReplicas}' 2>/dev/null)\" = \"1\""
elif kubectl -n "$NAMESPACE" get "deployment/${RELEASE}-centaur-api" >/dev/null 2>&1; then
  check "api /health" kubectl exec -n "$NAMESPACE" "deploy/${RELEASE}-centaur-api" -- \
    curl -sf http://localhost:8000/health >/dev/null
else
  echo "FAIL no API deployment (enable apiRs or api in your values overlay)"
  FAIL=1
fi

if kubectl -n "$NAMESPACE" get "deployment/${RELEASE}-centaur-slackbotv2" >/dev/null 2>&1; then
  check "slackbotv2 -> api-rs" kubectl exec -n "$NAMESPACE" "deploy/${RELEASE}-centaur-slackbotv2" -- \
    node -e "fetch('http://$(centaur_api_rs_service):8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null
elif kubectl -n "$NAMESPACE" get "deployment/${RELEASE}-centaur-slackbot" >/dev/null 2>&1; then
  check "slackbot -> api" kubectl exec -n "$NAMESPACE" "deploy/${RELEASE}-centaur-slackbot" -- \
    node -e "fetch('http://${RELEASE}-centaur-api:8000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))" >/dev/null
fi

if kubectl -n "$NAMESPACE" get "deployment/centaur-api-proxy" >/dev/null 2>&1; then
  check "shared iron-proxy OPENAI_API_KEY set" kubectl exec -n "$NAMESPACE" deploy/centaur-api-proxy -- \
    sh -c 'test -n "$OPENAI_API_KEY" && test "$OPENAI_API_KEY" != OPENAI_API_KEY'
fi

echo ""
echo "==> Local tunnel path"
if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "OK   127.0.0.1:${PORT} port-forward"
else
  echo "FAIL 127.0.0.1:${PORT} port-forward (run: contrib/scripts/dev-slack-tunnel.sh)"
  FAIL=1
fi

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All checks passed."
else
  echo "One or more checks failed."
  exit 1
fi
