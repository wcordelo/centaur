#!/usr/bin/env bash
# Sync a local .env file into centaur-infra-env and restart dependent workloads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../lib/env-file.sh
source "$SCRIPT_DIR/../lib/env-file.sh"
# shellcheck source=../lib/slack-stack.sh
source "$SCRIPT_DIR/../lib/slack-stack.sh"

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
RELEASE="${CENTAUR_RELEASE:-centaur}"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd kubectl
require_cmd python3

ENV_FILE="$(resolve_centaur_env_file "$REPO_ROOT")" || {
  echo "FATAL: no .env file found. Set CENTAUR_ENV_FILE or create one at:" >&2
  echo "  $REPO_ROOT/.env" >&2
  echo "  $REPO_ROOT/../.env" >&2
  exit 1
}

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

for var in OP_SERVICE_ACCOUNT_TOKEN OP_VAULT SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACKBOT_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "FATAL: $var is required in $ENV_FILE" >&2
    exit 1
  fi
done

echo "==> Using env file: $ENV_FILE"
echo "==> Patching secret centaur-infra-env in namespace $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

patch_json="$(OPENAI_PATCH="${OPENAI_API_KEY:-}" ANTHROPIC_PATCH="${ANTHROPIC_API_KEY:-}" python3 - <<'PY'
import base64, json, os

keys = [
    "OP_SERVICE_ACCOUNT_TOKEN",
    "OP_VAULT",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "SLACKBOT_API_KEY",
]
if os.environ.get("OPENAI_PATCH"):
    keys.append("OPENAI_API_KEY")
if os.environ.get("ANTHROPIC_PATCH"):
    keys.append("ANTHROPIC_API_KEY")

data = {
    k: base64.b64encode(os.environ[k].encode()).decode()
    for k in keys
    if os.environ.get(k)
}
print(json.dumps({"data": data}))
PY
)"
kubectl -n "$NAMESPACE" patch secret centaur-infra-env --type merge -p "$patch_json" >/dev/null

restart_deps=(
  "${RELEASE}-centaur-api"
  "${RELEASE}-centaur-slackbot"
  "${RELEASE}-centaur-api-rs"
  "${RELEASE}-centaur-slackbotv2"
  "${RELEASE}-centaur-iron-control"
  "${RELEASE}-centaur-iron-control-worker"
  centaur-api-proxy
)

echo "==> Restarting dependent workloads"
for dep in "${restart_deps[@]}"; do
  if kubectl -n "$NAMESPACE" get "deployment/$dep" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" rollout restart "deployment/$dep"
  fi
done

for dep in "${restart_deps[@]}"; do
  if kubectl -n "$NAMESPACE" get "deployment/$dep" >/dev/null 2>&1; then
    kubectl -n "$NAMESPACE" rollout status "deployment/$dep" --timeout=180s
  fi
done

if centaur_slack_stack_label >/dev/null 2>&1; then
  echo "Done (slack stack: $(centaur_slack_stack_label))."
else
  echo "Done."
fi
