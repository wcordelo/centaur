#!/usr/bin/env bash
# Wire local Centaur iron-proxy to 1Password (service-account mode).
# Run from a shell where `op whoami` or `op vault list` works.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=../lib/env-file.sh
source "$SCRIPT_DIR/../lib/env-file.sh"

NAMESPACE="${CENTAUR_NAMESPACE:-centaur}"
VAULT="${OP_VAULT:-Private}"
SA_NAME="${CENTAUR_OP_SA_NAME:-centaur-iron-proxy}"

ENV_FILE="$(resolve_centaur_env_file "$REPO_ROOT")" || {
  echo "FATAL: no .env file found. Set CENTAUR_ENV_FILE or create one at:" >&2
  echo "  $REPO_ROOT/.env" >&2
  echo "  $REPO_ROOT/../.env" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "FATAL: missing command: $1" >&2; exit 1; }
}

require_cmd op
require_cmd kubectl
require_cmd openssl

if ! op vault get "$VAULT" >/dev/null 2>&1; then
  echo "FATAL: cannot access vault '$VAULT'. Run: eval \$(op signin)" >&2
  exit 1
fi

echo "==> Using env file: $ENV_FILE"

# shellcheck disable=SC1090
set -a
source "$ENV_FILE"
set +a

for var in OPENAI_API_KEY SLACK_BOT_TOKEN SLACK_SIGNING_SECRET SLACKBOT_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "FATAL: $var is required in $ENV_FILE" >&2
    exit 1
  fi
done

echo "==> Ensuring 1Password item OPENAI_API_KEY in vault '$VAULT'"
if op item get "OPENAI_API_KEY" --vault "$VAULT" --fields title >/dev/null 2>&1; then
  op item edit "OPENAI_API_KEY" --vault "$VAULT" "credential=${OPENAI_API_KEY}" >/dev/null
  echo "    Updated credential on existing item"
else
  op item create --category="API Credential" --title "OPENAI_API_KEY" \
    --vault "$VAULT" "credential=${OPENAI_API_KEY}" >/dev/null
  echo "    Created item"
fi

if [[ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" && "${OP_SERVICE_ACCOUNT_TOKEN}" != local-placeholder* ]]; then
  echo "==> Using OP_SERVICE_ACCOUNT_TOKEN from environment"
else
  echo "==> Creating service account '$SA_NAME' (read_items on $VAULT)"
  echo "    Save the token when prompted — it is shown only once."
  OP_SERVICE_ACCOUNT_TOKEN="$(op service-account create "$SA_NAME" \
    --vault "${VAULT}:read_items" --raw)"
  echo "    Service account token captured (${#OP_SERVICE_ACCOUNT_TOKEN} chars)"
fi

export OP_VAULT="$VAULT"
export OP_SERVICE_ACCOUNT_TOKEN

echo "==> Patching Kubernetes secret centaur-infra-env in namespace $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

patch_json="$(python3 - <<PY
import base64, json, os
data = {
    "OP_VAULT": base64.b64encode(os.environ["OP_VAULT"].encode()).decode(),
    "OP_SERVICE_ACCOUNT_TOKEN": base64.b64encode(os.environ["OP_SERVICE_ACCOUNT_TOKEN"].encode()).decode(),
    "SLACK_BOT_TOKEN": base64.b64encode(os.environ["SLACK_BOT_TOKEN"].encode()).decode(),
    "SLACK_SIGNING_SECRET": base64.b64encode(os.environ["SLACK_SIGNING_SECRET"].encode()).decode(),
    "SLACKBOT_API_KEY": base64.b64encode(os.environ["SLACKBOT_API_KEY"].encode()).decode(),
}
print(json.dumps({"data": data}))
PY
)"
kubectl -n "$NAMESPACE" patch secret centaur-infra-env --type merge -p "$patch_json" >/dev/null
echo "    Patched OP_VAULT, OP_SERVICE_ACCOUNT_TOKEN, and Slack keys"

echo "==> Restarting API, slackbot, and iron-proxy"
kubectl -n "$NAMESPACE" rollout restart deployment/centaur-centaur-api deployment/centaur-centaur-slackbot deployment/centaur-api-proxy
kubectl -n "$NAMESPACE" rollout status deployment/centaur-centaur-api --timeout=120s
kubectl -n "$NAMESPACE" rollout status deployment/centaur-api-proxy --timeout=120s

echo ""
echo "Done. iron-proxy resolves: op://${VAULT}/OPENAI_API_KEY/credential"
echo "Optional: add to $ENV_FILE for future bootstraps:"
echo "  OP_VAULT=${VAULT}"
echo "  OP_SERVICE_ACCOUNT_TOKEN=<token you saved>"
