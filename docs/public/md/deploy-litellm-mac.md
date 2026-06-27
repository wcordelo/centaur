# Deploy Centaur with in-cluster LiteLLM (Mac laptop → Mac Studio)

This runbook covers the **LiteLLM overlay** path: Codex talks to a private
in-cluster LiteLLM Service. Tool and HTTPS egress still routes through
per-sandbox **iron-proxy**; **LLM traffic to in-cluster LiteLLM bypasses the
proxy** (see [Routing](#routing) below).

## Architecture

```
Slack → slackbotv2 → api-rs → centaur-agent (Codex, modelProvider=vllm)
                              ↓ NO_PROXY (direct)
                         centaur-centaur-litellm:4000 → OpenAI
                              ↓ HTTPS_PROXY (iron-proxy)
                         github.com, slack.com, …
```

### Routing

iron-proxy's tunnel listener supports **HTTPS CONNECT** only. Plain HTTP
requests to `http://centaur-centaur-litellm:4000/...` through `HTTPS_PROXY`
return **405 Method Not Allowed**. In-cluster LiteLLM therefore uses the same
pattern as host vLLM and OTLP bypass:

- api-rs adds the LiteLLM Service host to sandbox **`NO_PROXY`**
- NetworkPolicy allows **direct** sandbox → LiteLLM egress on port 4000
- api-rs injects the real **`LITELLM_MASTER_KEY`** into sandbox `VLLM_API_KEY`
  at pod create time (chart template still says `VLLM_API_KEY=LITELLM_API_KEY`)

Real **`OPENAI_API_KEY`** lives **only** on the LiteLLM pod (`centaur-litellm-env`).

### Required sandbox env

| Variable | Value | Why |
|----------|--------|-----|
| `CODEX_USE_VLLM` | `1` | Selects `config.vllm.toml` in the agent entrypoint |
| `CODEX_MODEL_PROVIDER` | `vllm` | harness-server must pass `modelProvider=vllm` to Codex at thread start |
| `VLLM_BASE_URL` | `http://centaur-centaur-litellm:4000/v1` | Codex vLLM provider base URL |
| `CODEX_MODEL` | e.g. `openai/gpt-4o-mini` | Must match a model in `contrib/litellm/config.yaml` |

Without **`CODEX_MODEL_PROVIDER=vllm`**, harness-server defaults to
`modelProvider=openai` while `config.toml` says `vllm` — turns hang after
`remoteControl/status/changed` with no LiteLLM traffic.

## Layer on top of local-slack overlay

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml,contrib/chart/values.litellm.example.yaml
```

## Prerequisites (both Macs)

```bash
brew install just kubectl helm jq kind cloudflared
# Docker Desktop or OrbStack

kind create cluster --name centaur
kubectl config use-context kind-centaur
```

Create `.env` at the repo root (see [local-slack-dev.md](local-slack-dev.md)):

| Variable | Notes |
|----------|--------|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACKBOT_API_KEY` | Slack + internal api-rs auth |
| `OP_SERVICE_ACCOUNT_TOKEN`, `OP_VAULT` | Placeholder OK for env-mode (`local-placeholder`) |
| `LITELLM_MASTER_KEY` | `openssl rand -hex 32` |
| `OPENAI_API_KEY` | Real key — **LiteLLM pod only**; do not sync into `centaur-infra-env` on this path |

**OpenAI account:** Codex uses the Responses API (`wire_api = "responses"`).
Some orgs must [verify the organization](https://platform.openai.com/settings/organization/general)
before full Codex turns succeed; a simple LiteLLM curl may work while Codex gets
403 until verification completes.

## Phase 1 — Mac laptop

### 1. Build and load images (Apple Silicon)

```bash
just build-one api-rs
just build-one slackbotv2
just build-one iron-proxy
just build-one agent
contrib/scripts/build-iron-control-local.sh
kind load docker-image centaur-api-rs:latest centaur-slackbotv2:latest \
  centaur-iron-proxy:latest centaur-agent:latest iron-control:local-arm64 \
  --name centaur
```

After changing `services/sandbox/entrypoint.sh`, rebuild and reload **agent**.

### 2. Bootstrap secrets + deploy

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml,contrib/chart/values.litellm.example.yaml
just bootstrap-secrets
just up
just status
```

### 3. Verify LiteLLM + api-rs

```bash
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -fsS http://localhost:8080/healthz

# Confirm sandbox template env on api-rs
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- printenv SESSION_SANDBOX_EXTRA_ENV \
  | jq -r '.[] | select(.name|test("CODEX|VLLM")) | "\(.name)=\(.value)"'
```

Expect `CODEX_MODEL_PROVIDER=vllm`, `CODEX_USE_VLLM=1`, and
`VLLM_BASE_URL=http://centaur-centaur-litellm:4000/v1`.

### 4. Verify sandbox → LiteLLM (direct)

Start a session (CLI or `@bot`), then:

```bash
contrib/scripts/verify-litellm-direct-egress.sh
```

Or manually from a sandbox pod:

```bash
SANDBOX_POD=$(kubectl get pods -n centaur -l centaur.ai/managed-by=api-rs -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n centaur "$SANDBOX_POD" -- bash -lc \
  'curl -sS --noproxy "*" -H "Authorization: Bearer $VLLM_API_KEY" \
   -H "Content-Type: application/json" \
   -d "{\"model\":\"openai/gpt-4o-mini\",\"input\":\"Say PONG\"}" \
   http://centaur-centaur-litellm:4000/v1/responses | head -c 200'
```

Pass: HTTP 200 and LiteLLM logs show `POST /v1/responses`. Sandbox `NO_PROXY`
must include `centaur-centaur-litellm`; `VLLM_API_KEY` must be the real master
key prefix (not the literal placeholder `LITELLM_API_KEY`).

### 5. Session E2E (no Slack)

```bash
THREAD_KEY=cli:litellm-e2e-1
THREAD_PATH=$(jq -rn --arg v "$THREAD_KEY" '$v|@uri')

kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -s -X POST \
  "http://localhost:8080/api/session/${THREAD_PATH}" \
  -H "Content-Type: application/json" \
  -d '{"harness_type":"codex","on_harness_conflict":"restart"}'

kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -s -X POST \
  "http://localhost:8080/api/session/${THREAD_PATH}/messages" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"Reply with exactly PONG and nothing else."}]}]}'

EXECUTE=$(kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -s -X POST \
  "http://localhost:8080/api/session/${THREAD_PATH}/execute" \
  -H "Content-Type: application/json" \
  -d '{"input_lines":["{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG and nothing else.\"}]}}"]}')
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')

kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -s -N \
  "http://localhost:8080/api/session/${THREAD_PATH}/events?execution_id=${EXECUTION_ID}&after_event_id=0"
```

Expect `thread/started` with `"modelProvider":"vllm"`, then LiteLLM
`POST /v1/responses` in `kubectl logs deploy/centaur-centaur-litellm`.

### 6. Slack ingress

**Cloudflare (quick laptop test):**

```bash
kubectl port-forward -n centaur svc/centaur-centaur-slackbotv2 3001:3001
# other terminal:
cloudflared tunnel --url http://localhost:3001
```

**Tailscale Funnel (laptop or Studio):** enable Funnel + HTTPS certificates in
the [Tailscale admin console](https://login.tailscale.com/admin/dns) first, then:

```bash
kubectl port-forward -n centaur svc/centaur-centaur-slackbotv2 3001:3001 &
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg 3001
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status
```

Set Slack app **Request URL** to `https://<host>/api/webhooks/slack` (also accepts
`/api/slack/events`).

### 7. E2E verification

| Check | Criterion |
|-------|-----------|
| Codex thread | Event stream shows `"modelProvider":"vllm"` |
| LiteLLM hit | `kubectl logs -n centaur deploy/centaur-centaur-litellm` shows `POST /v1/responses` during turn |
| No OpenAI bypass | Sandbox does **not** call `api.openai.com` directly (only LiteLLM pod holds `OPENAI_API_KEY`) |
| Secret hygiene | New sandboxes get real master key in `VLLM_API_KEY`; `OPENAI_API_KEY` absent from sandbox env |
| Slack reply | `@bot` in a channel where the bot is invited |

## Phase 2 — Mac Studio (always-on)

Repeat Phase 1, then add stable Slack ingress:

```bash
# Install Tailscale operator first — see operate/tailscale-funnel.md
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml,contrib/chart/values.litellm.example.yaml,contrib/chart/values.tailscale-funnel.example.yaml
just up
```

Slack **Request URL**: `https://centaur-slackbotv2.<your-tailnet>.ts.net/api/webhooks/slack`

### Always-on checklist

| Item | Action |
|------|--------|
| Sleep | System Settings → prevent sleep on power adapter |
| Docker | Start at login (Docker Desktop / OrbStack) |
| kind after reboot | Docker up → `kubectl cluster-info` → `just up` (or launchd below) |
| Warm pool | `sandboxWarmPoolSize: 0` on laptop; `0–1` on Studio in `values.litellm.example.yaml` |
| Secrets | Copy `.env` securely (1Password); never commit |

### Optional launchd auto-restart (Mac Studio)

```bash
cp contrib/scripts/macos/com.centaur.kind-up.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.centaur.kind-up.plist
```

Edit the plist `CENTAUR_REPO` / paths to your centaur checkout. The script waits for
Docker, verifies the kind cluster, then runs `just up`.

## Secret hygiene (important)

- **Do** put `OPENAI_API_KEY` only in `centaur-litellm-env` (via `just bootstrap-secrets` with `OPENAI_API_KEY` set).
- **Do** put `LITELLM_MASTER_KEY` in bootstrap; api-rs copies it into sandbox `VLLM_API_KEY` when `VLLM_BASE_URL` points at in-cluster LiteLLM.
- **Do not** run `contrib/scripts/sync-local-env.sh` with a real `OPENAI_API_KEY` on this path — that copies the provider key into `centaur-infra-env` and iron-control may inject it for `api.openai.com`.

## Tool grants

Simple text replies need no extra grants. Before tool-heavy prompts:

```bash
cd services/api-rs
export IRON_CONTROL_URL=http://localhost:3000  # or port-forward console
export IRON_CONTROL_API_KEY=iak_...            # from centaur-infra-env
cargo run -p centaur-perms -- principals grant slack-channel-<team>-<channel> --tool github --tools-dir ../../tools
```

## Troubleshooting

| Symptom | Likely cause |
|---------|----------------|
| Turn hangs after `remoteControl/status/changed` only | Missing `CODEX_MODEL_PROVIDER=vllm` — redeploy overlay, recycle sandboxes |
| 405 via `HTTPS_PROXY` to LiteLLM | Expected — use direct path (`NO_PROXY`); do not curl LiteLLM through iron-proxy |
| LiteLLM curl OK, Codex turn 403 | OpenAI org verification for Responses API; try after verifying org or use a permitted model |
| 401 from LiteLLM | Wrong or missing master key in sandbox — rebuild api-rs, cold-create sandbox |
| Codex hits `api.openai.com` | `CODEX_MODEL_PROVIDER` not `vllm` or `CODEX_USE_VLLM` unset — check `SESSION_SANDBOX_EXTRA_ENV` |
| LiteLLM pod CrashLoop | Missing `centaur-litellm-env` — bootstrap with `OPENAI_API_KEY` + `LITELLM_MASTER_KEY` |
| Tailscale funnel fails | Enable Funnel + HTTPS certs in tailnet admin; visit the enable URL from `tailscale funnel` CLI output |
| Slack 200 but no reply | Bot not in channel, missing `channels:history`, or fake channel in manual webhook tests |

## Related

- [Local Slack development](local-slack-dev.md)
- [Tailscale Funnel](/operate/tailscale-funnel)
- [Local model development (host vLLM)](local-model-development.md)
