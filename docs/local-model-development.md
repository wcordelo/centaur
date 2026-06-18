# Local model development with vLLM and Gemma 4

This guide covers running **Gemma 4** behind a local [vLLM](https://docs.vllm.ai/) OpenAI-compatible server for Centaur development. It complements the Slack-specific walkthrough in [docs/public/md/local-slack-dev.md](public/md/local-slack-dev.md).

## What already exists in this repo

Centaur does **not** ship n8n router config, a `schema-evolution-loop`, or a generic multi-model LLM router. Local-model orchestration is intentionally narrow:

| Piece | Location | Role |
|-------|----------|------|
| Codex vLLM provider config | `harness/codex/config.vllm.toml` | Points Codex at `VLLM_BASE_URL`, `wire_api = "responses"` |
| Sandbox entrypoint | `services/sandbox/entrypoint.sh` | Activates `config.vllm.toml` when `CODEX_USE_VLLM=1`; injects `CODEX_MODEL` / `VLLM_BASE_URL` |
| Helm overlay snippet | `contrib/chart/values.local-slack.example.yaml` | `sandbox.extraEnv` for vLLM + dev-only egress |
| vLLM start (Apple Silicon) | `contrib/scripts/start-local-vllm-gemma4.sh` | Serves Gemma 4 E2B via [vllm-mlx](https://github.com/waybarrios/vllm-mlx) |
| Gemma 4 weight patch | `contrib/scripts/patch-local-vllm-gemma4.sh` | `strict=False` load for KV-shared checkpoint keys |
| Sandbox egress allowlist | `services/api-rs/crates/centaur-api-server/src/args.rs` | Opens a **dev-only** NetworkPolicy hole when `CODEX_USE_VLLM=1` and host is allowlisted |
| NO_PROXY injection | `services/api-rs/crates/centaur-sandbox-agent-k8s/src/iron_proxy.rs` | Keeps local vLLM HTTP off iron-proxy |

Use this guide when you are iterating on the **model server** itself (tool parsing, reasoning, JSON schema). Use `local-slack-dev.md` when you want the full **kind + Slack + sandbox** path.

---

## Quick start

### 1. One-time venv (Apple Silicon)

```bash
mkdir -p .local-vllm && cd .local-vllm
python3.11 -m venv .venv && source .venv/bin/activate
pip install 'vllm-mlx @ git+https://github.com/waybarrios/vllm-mlx.git'
cd ..
```

### 2. Start Gemma 4

```bash
# MLX / Mac (default checkpoint: mlx-community/gemma-4-e2b-it-mxfp4)
contrib/scripts/start-local-vllm-gemma4.sh

# Linux / CUDA (requires upstream vLLM installed)
contrib/scripts/start-local-vllm-gemma4-cuda.sh
```

API base: `http://127.0.0.1:8000/v1` — served model name defaults to **`gemma`** (must match `CODEX_MODEL` in the Centaur overlay).

### 3. Verify parsing before touching Centaur

```bash
contrib/scripts/test-local-vllm-gemma4.py
# or against a remote host:
VLLM_BASE_URL=http://192.168.1.10:8000/v1 VLLM_MODEL=gemma contrib/scripts/test-local-vllm-gemma4.py
```

### 4. Point Centaur sandboxes at vLLM (optional)

Uncomment `sandbox.extraEnv` in `contrib/config/local-vllm/centaur-sandbox-vllm.extraEnv.yaml` (or `contrib/chart/values.local-slack.example.yaml`), rebuild the agent image with the Codex harness, and redeploy. See [Centaur integration](#centaur-integration) below.

---

## vLLM flags for Gemma 4

Gemma 4 uses a dedicated tool and reasoning protocol (`<|tool_call>`, `<|channel>thought`, etc.). Upstream vLLM expects these flags for tool + thinking mode:

```bash
vllm serve <model-id> \
  --served-model-name gemma \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 8192 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --chat-template examples/tool_chat_template_gemma4.jinja
```

| Flag | Why |
|------|-----|
| `--tool-call-parser gemma4` | Parses Gemma 4 native tool blocks into OpenAI `tool_calls` |
| `--reasoning-parser gemma4` | Splits `<\|channel>thought…<channel\|>` into `reasoning_content` |
| `--enable-auto-tool-choice` | Required when clients send `tools` / `tool_choice` |
| `--chat-template …gemma4.jinja` | CUDA path: official tool template from the vLLM repo |

The MLX helper (`start-local-vllm-gemma4.sh`) enables `--tool-call-parser gemma4` today. Add `--reasoning-parser gemma4` on CUDA builds where your vLLM version supports it.

Reference: [vLLM Gemma 4 recipe](https://docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html).

---

## Stop tokens, EOS, and `<|channel>` workarounds

### Known issue: E2B + Codex + Slack

The **Gemma 4 E2B** MLX checkpoint (`mlx-community/gemma-4-e2b-it-mxfp4`) is trained for Codex-style control tokens. Without a reasoning parser (or with `skip_special_tokens=true`), **`<|channel>` markers leak into user-visible text** — Slack replies show bullets, backticks, and token soup. Centaur documents this in `values.local-slack.example.yaml` and `local-slack-dev.md`.

**Mitigations (pick one or combine):**

1. **Use OpenAI for Slack dev** (default overlay) — reliable path.
2. **Enable `--reasoning-parser gemma4`** on CUDA vLLM and verify with `test-local-vllm-gemma4.py --check-reasoning`.
3. **Request `skip_special_tokens: false`** when calling the API directly so the reasoning parser can see channel markers (vLLM may set this automatically when the gemma4 reasoning parser is active; see [vllm#38855](https://github.com/vllm-project/vllm/issues/38855)).
4. **Try a non-E2B instruct checkpoint** if you only need chat + tools, not Codex wire format.
5. **Strip control tokens in the harness** (future Centaur work) before Slack delivery.

### Stop / EOS notes

- Gemma 4 thinking mode emits **extra tokens** for the reasoning chain — raise `--max-model-len` and client `max_tokens` accordingly.
- For throughput benchmarks only, vLLM supports `--ignore-eos` (see upstream recipe); do **not** use this in agent loops.
- If generation ends early with pad-token loops under concurrent tool calls, reduce concurrency or upgrade vLLM — see [vllm#39392](https://github.com/vllm-project/vllm/issues/39392).
- Streaming tool calls with booleans were corrupted in some vLLM versions (`true` → `"trutrue"`); prefer non-streaming tool verification or upgrade vLLM — see [vllm#39089](https://github.com/vllm-project/vllm/issues/39089).

### Gemma 4 MLX weight loading

Gemma 4 checkpoints include KV-shared layer weights that strict loaders reject. Run once per venv:

```bash
contrib/scripts/patch-local-vllm-gemma4.sh
```

This patches `mlx_vlm` / `vllm_mlx` to call `load(..., strict=False)` for `gemma-4` / `gemma4` model ids.

---

## Strict JSON schema types

vLLM exposes OpenAI-style `response_format: { "type": "json_schema", … }`. For Gemma 4:

- Use **explicit JSON Schema types** (`"integer"` vs `"number"`, `"array"` with `"items"`, etc.).
- List every required field under `"required"`.
- Avoid ambiguous unions in small schemas while debugging — start with a flat object.
- Validate output with `json.loads` in your test script before wiring agents.

Example schema (also exercised by `test-local-vllm-gemma4.py`):

```json
{
  "type": "object",
  "properties": {
    "answer": { "type": "string" },
    "confidence": { "type": "integer", "minimum": 0, "maximum": 100 }
  },
  "required": ["answer", "confidence"],
  "additionalProperties": false
}
```

Pydantic `response_format` helpers work on CUDA vLLM when `guided_decoding` is available; the test script uses raw `json_schema` for portability.

---

## Configuration templates

Copy and edit files under `contrib/config/local-vllm/`:

| File | Purpose |
|------|---------|
| `gemma4.env.example` | Host-side env vars (`VLLM_MODEL`, `VLLM_PORT`, …) |
| `gemma4-cuda-serve.example.sh` | Full `vllm serve` invocation for Linux/GPU |
| `centaur-sandbox-vllm.extraEnv.yaml` | Drop-in `sandbox.extraEnv` for Helm overlays |

Environment variables consumed by Centaur sandboxes:

| Variable | Example | Notes |
|----------|---------|-------|
| `CODEX_USE_VLLM` | `1` | Switches Codex to `config.vllm.toml` |
| `VLLM_BASE_URL` | `http://host.docker.internal:8000/v1` | Must use allowlisted host from kind pods |
| `VLLM_API_KEY` | `local` | Placeholder; not sent to real OpenAI |
| `CODEX_MODEL` | `gemma` | Must match `--served-model-name` |
| `NO_PROXY` | `host.docker.internal,host.orb.internal` | Bypass iron-proxy for local HTTP |

`harness/codex/config.vllm.toml` defaults:

```toml
model = "gemma"
model_provider = "vllm"
wire_api = "responses"

[model_providers.vllm]
base_url = "http://host.docker.internal:8000/v1"
env_key = "VLLM_API_KEY"
```

Entrypoint overrides `model` and `base_url` from `CODEX_MODEL` / `VLLM_BASE_URL` at container start.

---

## Centaur integration

### Build agent image (Codex harness)

```bash
export CENTAUR_SANDBOX_HARNESS=codex
just build-one agent
kind load docker-image centaur-agent:latest --name centaur
```

### Enable vLLM in the cluster

```bash
export CENTAUR_EXTRA_VALUES=contrib/chart/values.local-slack.example.yaml
# Edit overlay: uncomment sandbox.extraEnv vLLM block
just up
```

**Security:** `CODEX_USE_VLLM=1` creates a **port-scoped** egress hole (TCP port from `VLLM_BASE_URL`, default 8000) that is **not destination-scoped**. Allowed hosts: `host.docker.internal`, `host.orb.internal`, `localhost`, `127.0.0.1`, `::1`. Never enable in production.

### Smoke test from a pod

```bash
kubectl run -n centaur curl-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -sS --max-time 5 http://host.docker.internal:8000/v1/models
```

Start a **new Slack thread** after toggling vLLM — existing sandboxes keep the previous LLM config.

### Cloud VM (no Kubernetes)

`centaur-api-server` with `SESSION_SANDBOX_BACKEND=local` and mock harness does not exercise vLLM. Use `test-local-vllm-gemma4.py` against a vLLM process on another machine, or run the full kind stack on a Mac/Linux dev host.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `Connection refused` from sandbox | vLLM not running or wrong host | Start server; use `host.docker.internal` / OrbStack `host.orb.internal` |
| Egress hole not created | `VLLM_BASE_URL` host not allowlisted | Use loopback or Docker host gateway hostnames only |
| Garbled Slack text with `<\|channel>` | E2B + missing reasoning parser | Use OpenAI overlay or enable `--reasoning-parser gemma4` |
| Empty `tool_calls` | Missing `--tool-call-parser gemma4` | Restart vLLM with parser flags |
| JSON schema parse errors | Loose schema types | Tighten `type`/`required`; check raw `message.content` |
| `strict` load failure on MLX | Unpatched venv | Run `patch-local-vllm-gemma4.sh` |
| Pad-token loops under load | Concurrent tool-call parser bug | Serialize requests or upgrade vLLM |

---

## Related links

- [Local Slack development](public/md/local-slack-dev.md) — tunnel, iron-proxy, full stack
- [vLLM Codex integration](https://docs.vllm.ai/en/stable/serving/integrations/codex/)
- [vLLM Gemma 4 recipe](https://docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html)
- `contrib/scripts/test-local-vllm-gemma4.py` — local verification harness
