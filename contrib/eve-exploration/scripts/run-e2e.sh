#!/usr/bin/env bash
# End-to-end smoke test for the Centaur Eve demo agent.
# Requires Node 24+, a valid OPENAI_API_KEY (or AI_GATEWAY_API_KEY), and a built app.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="$ROOT/centaur-eve-demo"
ARTIFACTS="$ROOT/artifacts"
mkdir -p "$ARTIFACTS"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1090
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
  nvm use 24 >/dev/null
  export PATH="$NVM_DIR/versions/node/v24.16.0/bin:$PATH"
fi

cd "$DEMO"

echo "==> typecheck"
npm run typecheck | tee "$ARTIFACTS/typecheck.log"

echo "==> build"
npm run build | tee "$ARTIFACTS/build.log"

echo "==> direct tool execution"
node --input-type=module -e "
import tool from './agent/tools/describe_centaur.ts';
console.log(JSON.stringify(await tool.execute({ topic: 'architecture' }), null, 2));
" | tee "$ARTIFACTS/tool-describe-centaur.json"

echo "==> start server (background)"
npm run start -- --host 127.0.0.1 --port 3000 >"$ARTIFACTS/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT
sleep 2

echo "==> create session"
curl -sS -D "$ARTIFACTS/session-headers.txt" -o "$ARTIFACTS/session-body.json" \
  -X POST http://127.0.0.1:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Call describe_centaur with topic architecture, then answer in one sentence."}'

SESSION_ID="$(awk 'tolower($0) ~ /^x-eve-session-id:/ {print $2}' "$ARTIFACTS/session-headers.txt" | tr -d '\r')"
echo "session_id=$SESSION_ID" | tee "$ARTIFACTS/session-id.txt"

echo "==> stream session"
curl -sS -N --max-time 120 \
  "http://127.0.0.1:3000/eve/v1/session/${SESSION_ID}/stream" \
  | tee "$ARTIFACTS/session-stream.ndjson"

echo "==> done; artifacts in $ARTIFACTS"
