---
title: Local Slack development with kind
description: Run Centaur on a local Kubernetes cluster and receive Slack @-mentions through a tunnel.
---

# Local Slack development with kind

Use this guide when Centaur runs on a **local** Kubernetes cluster (kind, k3s, etc.) and you want Slack `@bot` mentions to reach the in-cluster slackbot.

The example overlay (`contrib/chart/values.local-slack.example.yaml`) deploys **slackbot v2 + api-rs**. Do not enable v1 `slackbot` and v2 `slackbotv2` on the same Slack app — both would answer events.

For architecture and API details, see [AGENTS.md](/AGENTS.md) in the repo root. For always-on hosts without a laptop tunnel, see [mac-mini-setup](/mac-mini-setup) or [Tailscale Funnel](/operate/tailscale-funnel).

## Prerequisites

```bash
brew install just kubectl helm jq kind cloudflared
kind create cluster --name centaur   # once; any cluster name is fine
kubectl config use-context kind-centaur
```

Clone Centaur (and optionally an organization overlay repo) anywhere on your machine. Example layout:

```text
workspace/
├── centaur/                 # this repo
├── centaur-overlay/         # optional org tools/workflows
└── .env                     # local secrets (never commit)
```

## Secrets (`.env`)

Create a `.env` file that scripts can find. Resolution order:

1. `CENTAUR_ENV_FILE` (explicit path)
2. `<centaur-repo>/.env`
3. `<parent-of-centaur>/.env` (sibling layout above)
4. `./.env` from your current working directory

Required variables:

| Variable | Notes |
|----------|-------|
| `SLACK_BOT_TOKEN` | Slack app Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACKBOT_API_KEY` | Centaur-internal key (not from Slack); must match API config |
| `OPENAI_API_KEY` | **Default** for the example overlay (Codex → OpenAI via iron-proxy); synced by `sync-local-env.sh` |
| `ANTHROPIC_API_KEY` | Only if you set `sandbox.harnessEngine: claudecode` instead of the local overlay default |
| `OP_SERVICE_ACCOUNT_TOKEN` | Placeholder OK for env mode (e.g. `local-placeholder`) |
| `OP_VAULT` | Placeholder OK for env mode |

Never commit `.env`. Rotate any key that was exposed in logs or chat.

## Slack app OAuth scopes

The slackbot calls `conversations.replies` to load thread context. Your log error (`missing_scope`) means the **bot token** is missing a **history** scope for that channel type.

### Where to add scopes in the Slack UI

1. Open [api.slack.com/apps](https://api.slack.com/apps) and select your app.
2. Left sidebar → **OAuth & Permissions** (under *Features*, not Settings).
3. Scroll to **Scopes** → **Bot Token Scopes** (ignore *User Token Scopes* unless you know you need them).
4. Click **Add an OAuth Scope** and use the **search box**. Slack shows friendly names; the API id is what you add.

| Search for… | API scope added | Needed when… |
|-------------|-----------------|--------------|
| `channel history` | `channels:history` | `@bot` in a **public channel thread** (your error) |
| `mention` | `app_mentions:read` | Receiving `@bot` events |
| `chat write` or `send messages` | `chat:write` | Bot posting replies |
| `channel read` | `channels:read` | Public channel metadata |
| `private channel history` | `groups:history` | Threads in private channels |
| `private channel read` | `groups:read` | Private channels |
| `im history` | `im:history` | DM threads |
| `users read` | `users:read` | Display names (optional) |
| `reactions write` | `reactions:write` | 👌 ack reaction (optional) |
| `files write` | `files:write` | Bot uploads files (optional) |

**Minimum fix for your error:** add **`channels:history`** only, then reinstall.

You may **not** see scopes like `assistant:write` unless the app is configured as a Slack Assistant — **slackbot v2** uses `assistant:write` for Assistant thread status/title; v1 degrades gracefully without it.

### Easier: paste a manifest

**Settings → App Manifest** → YAML tab. Merge or replace with `contrib/slack/app-manifest.example.yaml` from this repo (set `request_url` to your tunnel). Save, reinstall, refresh tokens.

After any scope change:

1. **Install App** (top of OAuth & Permissions) or **Reinstall to Workspace**
2. Copy **Bot User OAuth Token** → `.env` as `SLACK_BOT_TOKEN`
3. `contrib/scripts/sync-local-env.sh`
4. `/invite @your-bot` in the test channel (history scopes only apply where the bot is a member)

## Deploy

The example overlay enables **slackbot v2** (port 3001) talking to **api-rs** (port 8080). Build those images before the first deploy:

```bash
just build-one api-rs
just build-one slackbotv2
just build-one iron-proxy
just build-one agent    # sandboxes spawned by api-rs
```

Deploying slackbot alone, or using `helm upgrade ... --reuse-values` without checking the result, commonly leaves api-rs missing and breaks Slack.

From the **centaur repo root**:

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml
just up
```

`CENTAUR_EXTRA_VALUES` can be any absolute or repo-relative path to a values overlay. The example file enables slackbotv2, api-rs, env-mode iron-proxy, and disables the Python api / v1 slackbot.

Ensure `centaur-infra-env` includes `DATABASE_URL` (slackbotv2 reads `SLACKBOTV2_DATABASE_URL` from it). If you have not bootstrapped yet:

```bash
just bootstrap-secrets
```

**Apple Silicon (arm64 kind):** api-rs needs **iron-control**, but `ironsh/iron-control:latest` is amd64-only. Build a native image once:

```bash
contrib/scripts/build-iron-control-local.sh
kind load docker-image iron-control:local-arm64 --name centaur
```

The local overlay points `ironControl.image` at `iron-control:local-arm64`.

After editing `.env`:

```bash
contrib/scripts/sync-local-env.sh
```

This patches `centaur-infra-env` and restarts api-rs, slackbotv2, and any other deployed dependents.

## LLM backend (default: OpenAI)

The example overlay uses **Codex + OpenAI** (`harness/codex/config.toml`, model `gpt-5.5`). Set `OPENAI_API_KEY` in `.env`, run `sync-local-env.sh`, and deploy. No extra `sandbox.extraEnv` is required.

After changing the overlay or api-rs image, **start a new Slack thread** or delete stale sandbox pods — each thread keeps its sandbox, and old pods retain the previous harness/env until recycled:

```bash
kubectl get pods -n centaur | grep asbx
kubectl delete pod -n centaur asbx-<id>-1 asbx-<id>-1-proxy-<id>   # per stale sandbox
```

Tail **slackbot v2** logs (not v1):

```bash
kubectl logs -n centaur deploy/centaur-centaur-slackbotv2 -f
```

## Optional: local LLM with vLLM (experimental)

> **Full guide:** [Local model development with vLLM and Gemma 4](/md/local-model-development.md) — server flags, stop/EOS workarounds, JSON schema, and `contrib/scripts/test-local-vllm-gemma4.py`.

> **Status:** Gemma 4 **E2B** checkpoints emit Codex `<|channel>` control tokens through vLLM; Slack replies are garbled (bullets, token soup) until we add response stripping or use a non-E2B model. Use **OpenAI** for reliable local Slack dev.

To try vLLM anyway, uncomment the `sandbox.extraEnv` block in `values.local-slack.example.yaml` and start a vLLM server on your Mac. Sandboxes use Codex’s [vLLM provider](https://docs.vllm.ai/en/stable/serving/integrations/codex/) (`wire_api = "responses"`).

### 1. Start vLLM on the host (Apple Silicon)

On Mac, use [vllm-mlx](https://github.com/waybarrios/vllm-mlx) (OpenAI-compatible API, including `/v1/responses` for Codex):

```bash
# one-time setup (repo-local venv)
mkdir -p centaur/.local-vllm && cd centaur/.local-vllm
python3.11 -m venv .venv && source .venv/bin/activate
pip install 'vllm-mlx @ git+https://github.com/waybarrios/vllm-mlx.git'

# serve Gemma 4 E2B (~4GB, fits M1 Max 64GB)
cd centaur
contrib/scripts/start-local-vllm-gemma4.sh
```

The helper script applies a small Gemma 4 weight-loading patch (KV-shared layers in the checkpoint are ignored with `strict=False`), then serves `mlx-community/gemma-4-e2b-it-mxfp4` as `gemma` on port 8000 with tool-calling enabled.

Override the checkpoint with `VLLM_MODEL=...` if needed.

The `--served-model-name gemma` must match `CODEX_MODEL` in the overlay.

On Linux/CUDA you can use upstream [vLLM + Gemma 4](https://docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html) instead:

```bash
vllm serve google/gemma-4-E4B-it --served-model-name gemma --host 0.0.0.0 --port 8000
```

Quick check from your Mac:

```bash
curl -s http://127.0.0.1:8000/v1/models | jq .
```

### 2. Build the agent image (codex harness + vLLM config)

```bash
export CENTAUR_SANDBOX_HARNESS=codex
just build-one agent
kind load docker-image centaur-agent:latest --name centaur
```

The image includes `harness/codex/config.vllm.toml`; entrypoint activates it when `CODEX_USE_VLLM=1`.

### 3. Host reachability from kind pods

Sandboxes call `http://host.docker.internal:8000/v1` (OrbStack: try `host.orb.internal` and update `VLLM_BASE_URL` in the overlay). The overlay adds those hosts to `NO_PROXY` so iron-proxy does not intercept plain HTTP to your Mac.

Per-sandbox **NetworkPolicy** normally blocks all egress except iron-proxy and api-rs. When `CODEX_USE_VLLM=1` and `VLLM_BASE_URL` points at an **allowlisted** host (`host.docker.internal`, `host.orb.internal`, `localhost`, `127.0.0.1`), api-rs adds a dev-only egress rule for that port (default TCP/8000). The rule is **port-scoped but not destination-scoped** — sandboxes can reach any IP on that port, not only your Mac. That is intentional for kind host-gateway dev but **must never be enabled in production** (do not deploy this overlay outside local clusters).

If `VLLM_BASE_URL` uses any other host, api-rs **refuses** to open the egress hole and logs a warning; vLLM will be unreachable from sandboxes until you fix the URL.

From a test pod:

```bash
kubectl run -n centaur curl-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS --max-time 5 http://host.docker.internal:8000/v1/models
```

### 4. Deploy and test

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml
just up
```

Start a **new Slack thread** after enabling vLLM (old sandboxes keep the previous OpenAI config).

To return to **OpenAI**, set `sandbox.extraEnv: {}` in the overlay, set `OPENAI_API_KEY` in `.env`, run `sync-local-env.sh`, restart api-rs, and delete stale `asbx-*` pods.

## Slack tunnel

Slack cannot reach the cluster directly. Keep a path from the internet to the slackbot service open while testing:

```bash
# One script (auto-detects v1 vs v2 service; port-forward + Cloudflare quick tunnel)
contrib/scripts/dev-slack-tunnel.sh
```

Or manually (v2):

```bash
kubectl port-forward -n centaur svc/centaur-centaur-slackbotv2 3001:3001
cloudflared tunnel --url http://127.0.0.1:3001   # prefer 127.0.0.1 over localhost
```

Set the Slack app **Event Subscriptions → Request URL** to:

```text
https://<trycloudflare-host>/api/webhooks/slack
```

Quick tunnel URLs change when cloudflared restarts — update Slack each time.

**Port-forward dies** when the slackbot pod restarts (`failed to find sandbox ... not found`). Restart port-forward after slackbot rollouts.

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `CENTAUR_NAMESPACE` | `centaur` | Kubernetes namespace |
| `CENTAUR_SLACKBOT_LOCAL_PORT` | `3001` | Local port for port-forward / tunnel |

## Health checks

```bash
contrib/scripts/dev-slack-health.sh
```

Manual checks:

```bash
curl -sf "http://127.0.0.1:${CENTAUR_SLACKBOT_LOCAL_PORT:-3001}/health"
kubectl exec -n centaur deploy/centaur-centaur-api-rs -- curl -sf http://localhost:8080/health
kubectl logs -n centaur deploy/centaur-centaur-slackbotv2 --tail=20
```

### Symptom → fix

| Symptom | Cause | Fix |
|---------|-------|-----|
| slackbotv2 crash / DB errors | Missing `DATABASE_URL` in secret | `just bootstrap-secrets`; verify `kubectl get secret centaur-infra-env -o jsonpath='{.data.DATABASE_URL}'` |
| api-rs not ready / Slack no reply | api-rs or agent-sandbox controller missing | `kubectl get pods -n centaur`; ensure `agentSandbox.enabled=true` (default) |
| `sandbox create sandbox was not found` | agent-sandbox CRDs missing (Helm skips CRDs on upgrade) | `kubectl apply -f contrib/chart/charts/agent-sandbox/crds/` then `kubectl rollout restart deploy/agent-sandbox-controller -n agent-sandbox-system` |
| `401` / `Invalid API key · Fix external API key` | Sandbox runs Claude but only OpenAI key is synced (or vice versa) | Use the example overlay (`sandbox.harnessEngine: codex`), build agent with `CENTAUR_SANDBOX_HARNESS=codex just build-one agent`, `kind load docker-image centaur-agent:latest`, redeploy, then `@bot` in a **new thread** |
| `401` / LLM auth in sandbox logs | Per-sandbox iron-proxy missing real key | `contrib/scripts/sync-local-env.sh`; start a new session (new sandbox) |
| cloudflared EOF / connection refused | Port-forward dead | Restart `dev-slack-tunnel.sh` |
| Empty bot replies | LLM auth failure in sandbox | Fix secrets; `@bot` again (new sandbox) |
| Garbled replies (`<|channel>`, `●`, backticks) | vLLM + Gemma E2B incompatible with Codex Slack path | Use OpenAI default overlay; or fix vLLM model/checkpoint |
| Good logs, bad reply in old thread | Stale sandbox reused | New thread or delete `asbx-*` pods for that thread |
| Debugging wrong component | Tailing v1 slackbot | `kubectl logs deploy/centaur-centaur-slackbotv2` |
| `slack_thread_history_collect_failed` / `missing_scope` | Bot token missing history scopes | Add scopes above; reinstall app; refresh `SLACK_BOT_TOKEN` and `sync-local-env.sh` |
| `ImagePullBackOff` on api-rs / slackbotv2 | Images not built | `just build-one api-rs` and `just build-one slackbotv2` |
| `final_delivery_poll_failed` (v1 only) | Python API not deployed | Use v2 overlay or enable `api.enabled=true` for v1 |

## End-to-end test

1. `contrib/scripts/dev-slack-health.sh`
2. `contrib/scripts/dev-slack-tunnel.sh` — copy tunnel URL into Slack app settings
3. In Slack: `@bot reply with exactly PONG`
4. `just logs slackbotv2` / `kubectl logs -n centaur deploy/centaur-centaur-api-rs --tail=50`

## Daily workflow

```bash
cd /path/to/centaur
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml
export CENTAUR_SANDBOX_HARNESS=codex   # matches overlay; OpenAI key in .env
just up
kind load docker-image centaur-agent:latest --name kind-centaur   # after agent rebuild
contrib/scripts/sync-local-env.sh      # after .env changes
contrib/scripts/dev-slack-tunnel.sh    # leave running
contrib/scripts/dev-slack-health.sh
```

## Helm pitfalls

- Avoid `--reuse-values` unless you know what it preserves; it can drop `apiRs.enabled=true`.
- Do not enable v1 `slackbot` and v2 `slackbotv2` on the same Slack app.
- Prefer a checked-in example values file + `CENTAUR_EXTRA_VALUES` over one-off `--set` flags.

## 1Password (optional)

When a 1Password service account can read your LLM vault, use `ironProxy.secretSource=onepassword` and `contrib/scripts/setup-ironproxy-onepassword.sh`.

Some personal 1Password accounts cannot grant service accounts access to Private or Communal vaults. In that case use **env mode** (`OPENAI_API_KEY` in `centaur-infra-env`) as shown in the example values file.

## Operational notes (local dev)

Summary of what the local Slack stack expects — useful when picking this up again:

| Layer | What to know |
|-------|----------------|
| **Overlay** | `contrib/chart/values.local-slack.example.yaml` — slackbotv2 + api-rs, v1 slackbot/api disabled, iron-control on arm64 |
| **Secrets** | `.env` → `contrib/scripts/sync-local-env.sh` → `centaur-infra-env` (includes `OPENAI_API_KEY`, Slack tokens, `SLACKBOT_API_KEY`) |
| **LLM** | Default OpenAI via iron-proxy; optional vLLM needs `CODEX_USE_VLLM=1` + allowlisted `VLLM_BASE_URL` |
| **NetworkPolicy** | api-rs opens a **dev-only** egress hole on the vLLM TCP port when vLLM env is validated (`host.docker.internal`, etc. only); port-scoped, not host-scoped — never enable in prod |
| **Sandboxes** | One `asbx-*` pod per Slack thread; config is fixed at create time — recycle pods after overlay/api-rs/agent image changes |
| **Tunnel** | `contrib/scripts/dev-slack-tunnel.sh` → Cloudflare URL → Slack Event Subscriptions Request URL `/api/webhooks/slack` |
| **Health** | `contrib/scripts/dev-slack-health.sh`; api-rs `:8080/health`, slackbotv2 `:3001/health` |

Code touched for vLLM host egress (when experimenting locally):

- `services/api-rs/crates/centaur-api-server/src/args.rs` — derives `host_egress_ports` from `SESSION_SANDBOX_EXTRA_ENV`
- `services/api-rs/crates/centaur-sandbox-agent-k8s/` — `AgentSandboxConfig.host_egress_ports`, NetworkPolicy in `iron_proxy.rs`

## Related

- [Quickstart — Slack app setup](/quickstart)
- [mac-mini-setup](/mac-mini-setup)
- [Tailscale Funnel](/operate/tailscale-funnel)
