# Deploy Centaur with in-cluster LiteLLM (Mac laptop → Mac Studio)

This runbook covers the **LiteLLM overlay** path: Codex talks to a private
in-cluster LiteLLM Service; **all** sandbox egress (LLM + tools) routes through
per-sandbox **iron-proxy**. Do not add `centaur-litellm` to `NO_PROXY`.

## Architecture

```
Slack → slackbotv2 → api-rs → centaur-agent (Codex)
                              ↓ HTTPS_PROXY
                         iron-proxy → centaur-centaur-litellm:4000 → OpenAI
                                    → github.com, slack.com, …
```

Real `OPENAI_API_KEY` lives **only** on the LiteLLM pod (`centaur-litellm-env`).
Sandboxes use placeholder `VLLM_API_KEY=LITELLM_API_KEY`; iron-proxy injects the
real `LITELLM_MASTER_KEY` for host `centaur-centaur-litellm`.

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
| `OPENAI_API_KEY` | Real key — **LiteLLM only**; do not run `sync-local-env.sh` with this on the LiteLLM path |

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

### 2. Bootstrap secrets + deploy

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml,contrib/chart/values.litellm.example.yaml
just bootstrap-secrets
just up
just status
```

### 3. Verify LiteLLM + routing

```bash
# LiteLLM health (direct, from api-rs pod)
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- \
  curl -sf http://centaur-centaur-litellm:4000/health/liveliness

# API health
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -fsS http://localhost:8080/healthz
```

### 4. Spike: iron-proxy → HTTP LiteLLM

After a sandbox exists (warm pool off, or trigger an @bot mention):

```bash
PROXY_POD=$(kubectl get pods -n centaur -l centaur.ai/iron-proxy=true -o jsonpath='{.items[0].metadata.name}')
SANDBOX_POD=$(kubectl get pods -n centaur -l centaur.ai/managed=true -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n centaur "$SANDBOX_POD" -- sh -c \
  'curl -sf -x "$HTTPS_PROXY" http://centaur-centaur-litellm:4000/health/liveliness'

kubectl logs -n centaur "$PROXY_POD" | grep proxy_audit | tail -5
```

Pass: curl returns OK and `proxy_audit` shows `centaur-centaur-litellm`.

### 5. Slack ingress (ephemeral tunnel)

```bash
kubectl port-forward -n centaur svc/centaur-centaur-slackbotv2 3001:3001
# other terminal:
cloudflared tunnel --url http://localhost:3001
```

Set Slack app **Request URL** to `https://<tunnel-host>/api/webhooks/slack`.

### 6. E2E verification

| Check | Command / criterion |
|-------|---------------------|
| Slack reply | @bot with a simple prompt |
| Proxy path | `kubectl logs -n centaur -l centaur.ai/iron-proxy=true \| grep centaur-centaur-litellm` during turn |
| No OpenAI bypass | No `api.openai.com` in harness `proxy_audit` during turn |
| LiteLLM upstream | `kubectl logs -n centaur deploy/centaur-centaur-litellm -f` shows provider call |
| Secret hygiene | Sandbox env has `VLLM_API_KEY=LITELLM_API_KEY`, not the real master key |

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
- **Do** put `LITELLM_MASTER_KEY` in bootstrap; the script mirrors it to `LITELLM_API_KEY` in `centaur-infra-env` for iron-proxy injection.
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
| Sandbox turn hangs on LLM | iron-proxy NetworkPolicy missing port 4000 — check `KUBERNETES_IRON_PROXY_ADDITIONAL_EGRESS_PORTS` on api-rs |
| 401 from LiteLLM | `LITELLM_API_KEY` not in infra-env or iron-control sync lag — re-run bootstrap, restart api-rs |
| Codex hits api.openai.com | `VLLM_BASE_URL` wrong or `CODEX_USE_VLLM` unset — check `SESSION_SANDBOX_EXTRA_ENV` on api-rs pod |
| LiteLLM pod CrashLoop | Missing `centaur-litellm-env` — run bootstrap with `OPENAI_API_KEY` + `LITELLM_MASTER_KEY` |
