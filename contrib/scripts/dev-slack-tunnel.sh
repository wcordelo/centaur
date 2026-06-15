#!/usr/bin/env bash
# Start port-forward + Cloudflare quick tunnel for local Slack webhooks.
# Keep this running while testing @bot mentions in Slack.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/slack-stack.sh
source "$SCRIPT_DIR/../lib/slack-stack.sh"

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
PORT="${CENTAUR_SLACKBOT_LOCAL_PORT:-3001}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd kubectl
require_cmd cloudflared

SLACK_SVC="$(centaur_slackbot_service_name)"
STACK="$(centaur_slack_stack_label)"

cleanup() {
  [[ -n "${PF_PID:-}" ]] && kill "$PF_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Slack stack: $STACK (svc/$SLACK_SVC -> 127.0.0.1:${PORT})"
kubectl port-forward -n "$NAMESPACE" "svc/$SLACK_SVC" "${PORT}:3001" >/dev/null &
PF_PID=$!
sleep 2

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "FATAL: slackbot not reachable on 127.0.0.1:${PORT}" >&2
  exit 1
fi
echo "    slackbot health OK"

echo ""
echo "==> Cloudflare tunnel (Request URL path: /api/webhooks/slack)"
echo "    Update Slack app Event Subscriptions when the URL changes."
echo ""
cloudflared tunnel --url "http://127.0.0.1:${PORT}"
