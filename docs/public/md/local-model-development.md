---
title: Local model development with vLLM and Gemma 4
description: Configure, serve, and validate Gemma 4 through vLLM for Centaur local development.
---

# Local model development with vLLM and Gemma 4

Centaur can route Codex harness sandboxes to a **local OpenAI-compatible vLLM server** instead of cloud LLMs. This guide covers Gemma 4 specifically: server flags, Centaur wiring, stop/EOS workarounds, strict JSON schema outputs, and a smoke-test script you can run before touching Slack or Kubernetes.

For the full Slack + kind overlay path, see [local Slack development](/md/local-slack-dev.md). This document focuses on the **model layer** — vLLM on your host and how Centaur consumes it.

## What already exists in the repo

Centaur ships several building blocks for local Gemma 4:

| Artifact | Purpose |
| --- | --- |
| [`contrib/scripts/start-local-vllm-gemma4.sh`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/start-local-vllm-gemma4.sh) | Apple Silicon launcher via [vllm-mlx](https://github.com/waybarrios/vllm-mlx) |
| [`contrib/scripts/start-local-vllm-gemma4-cuda.sh`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/start-local-vllm-gemma4-cuda.sh) | Linux/CUDA launcher with full Gemma 4 parser flags |
| [`contrib/scripts/patch-local-vllm-gemma4.sh`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/patch-local-vllm-gemma4.sh) | mlx weight-loading fix for KV-shared layers |
| [`contrib/scripts/test-local-vllm-gemma4.py`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/test-local-vllm-gemma4.py) | Smoke tests for chat, tools, reasoning, JSON schema |
| [`contrib/local-vllm/gemma4.env.example`](https://github.com/paradigmxyz/centaur/blob/main/contrib/local-vllm/gemma4.env.example) | Environment template for serve + Centaur overlay |
| [`harness/codex/config.vllm.toml`](https://github.com/paradigmxyz/centaur/blob/main/harness/codex/config.vllm.toml) | Codex provider config (`wire_api = "responses"`) |
| [`contrib/chart/values.local-slack.example.yaml`](https://github.com/paradigmxyz/centaur/blob/main/contrib/chart/values.local-slack.example.yaml) | Helm overlay with optional `CODEX_USE_VLLM` env |

There is **no** n8n router or `schema-evolution-loop` in this repository. LLM routing for sandboxes is:

1. **Helm overlay** → `sandbox.extraEnv` (`CODEX_USE_VLLM`, `VLLM_BASE_URL`, …)
2. **Sandbox entrypoint** → selects `harness/codex/config.vllm.toml` when `CODEX_USE_VLLM=1`
3. **api-rs** → dev-only NetworkPolicy host egress + `NO_PROXY` for allowlisted vLLM hosts

## Quick start

### 1. Start vLLM on the host

**Apple Silicon (recommended for laptop dev):**

```bash
mkdir -p .local-vllm && cd .local-vllm
python3.11 -m venv .venv && source .venv/bin/activate
pip install 'vllm-mlx @ git+https://github.com/waybarrios/vllm-mlx.git'

cd /path/to/centaur
contrib/scripts/start-local-vllm-gemma4.sh
```

**Linux / NVIDIA CUDA:**

```bash
# vLLM nightly or gemma4-tagged image — see vLLM Gemma 4 recipe
contrib/scripts/start-local-vllm-gemma4-cuda.sh
```

Both scripts serve an OpenAI-compatible API at `http://127.0.0.1:8000/v1` with `--served-model-name gemma` (override with `VLLM_SERVED_MODEL_NAME`).

### 2. Validate the endpoint

```bash
python3 contrib/scripts/test-local-vllm-gemma4.py \
  --base-url http://127.0.0.1:8000/v1 \
  --model gemma
```

All checks should pass before wiring Centaur.

### 3. Point Centaur sandboxes at vLLM

Uncomment the `sandbox.extraEnv` block in `contrib/chart/values.local-slack.example.yaml`:

```yaml
sandbox:
  harnessEngine: codex
  extraEnv:
    CODEX_USE_VLLM: "1"
    VLLM_API_KEY: local
    VLLM_BASE_URL: http://host.docker.internal:8000/v1
    CODEX_MODEL: gemma
    NO_PROXY: host.docker.internal,host.orb.internal
```

Rebuild the agent image with the Codex harness, redeploy, and start a **new** Slack thread (sandboxes pin config at create time). See [local Slack development](/md/local-slack-dev.md#optional-local-llm-with-vllm-experimental).

## Gemma 4 on vLLM — required server flags

Gemma 4 uses a **custom tool-call protocol** (`<|tool_call>`, `<tool_call|>`, `<|channel>thought`, …). Generic OpenAI chat serving is not enough; enable the Gemma 4 parsers:

| Flag | When required |
| --- | --- |
| `--enable-auto-tool-choice` | Tool / function calling (Codex agent turns) |
| `--tool-call-parser gemma4` | Parse Gemma 4 tool syntax into OpenAI `tool_calls` |
| `--reasoning-parser gemma4` | Expose thinking in `reasoning` / strip `<|channel>…<channel|>` |
| `--chat-template examples/tool_chat_template_gemma4.jinja` | Recommended on upstream CUDA vLLM (bundled in official images) |

The Centaur CUDA helper script sets all of these. The Apple Silicon `vllm-mlx` script sets the same parser flags when your vllm-mlx build supports them (see [vllm-mlx#380](https://github.com/waybarrios/vllm-mlx/issues/380)).

Reference: [vLLM Gemma 4 recipe](https://docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html).

### Example: full-featured CUDA serve

```bash
vllm serve google/gemma-4-E4B-it \
  --served-model-name gemma \
  --host 0.0.0.0 --port 8000 \
  --max-model-len 8192 \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --chat-template examples/tool_chat_template_gemma4.jinja
```

For Apple Silicon, `contrib/scripts/start-local-vllm-gemma4.sh` wraps the equivalent `vllm-mlx serve` invocation and applies [`patch-local-vllm-gemma4.sh`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/patch-local-vllm-gemma4.sh) first.

## Stop tokens and EOS workarounds

Gemma 4 chat models end turns with **`<turn|>`** (tokenizer id **106**), not the base model `<eos>` (id 1). Several failure modes show up in agentic / tool-call mode when stop handling is wrong.

### Symptoms

| Symptom | Likely cause |
| --- | --- |
| Generation runs until `max_tokens` with trailing `<turn|><turn|>` soup | `tokenizer_config.json` has wrong `eos_token` (merged checkpoints often reset to `<eos>`) |
| Raw `<|channel>`, `<|tool_call>`, `<tool_call|>` in user-visible text | Missing `--reasoning-parser gemma4` / `--tool-call-parser gemma4`, or streaming parser bugs on old vLLM |
| Tool args like `{"search_all": "trutrue"}` in streaming mode | Known gemma4 tool-parser streaming bug — prefer non-streaming smoke tests or upgrade vLLM |
| Infinite JSON repetition under `response_format: json_schema` | Grammar whitespace loops — use `disable_any_whitespace=true` (xgrammar backend) |

### Mitigations

**1. Verify EOS in the checkpoint**

For fine-tuned or merged weights, confirm `tokenizer_config.json` has:

```json
"eos_token": "<turn|>"
```

**2. Pass explicit stop tokens in API requests**

When testing or building a thin proxy in front of vLLM:

```json
{
  "stop": ["<turn|>", "<|tool_response|>"],
  "stop_token_ids": [106]
}
```

vLLM merges `<|tool_response|>` into stops when `--tool-call-parser gemma4` is active (required after tool results). On vllm-mlx, ensure you are on a build that includes the `<|tool_response>` stop fix (see [vllm-mlx#383](https://github.com/waybarrios/vllm-mlx/pull/383)).

**3. Enable reasoning + tool parsers**

Without `--reasoning-parser gemma4`, thinking delimiters leak into `content`. Centaur's Slack path then shows garbled bullets and token soup — especially with **Gemma 4 E2B** mlx checkpoints.

**4. Strip channel tokens in clients (last resort)**

If you cannot upgrade vLLM yet, post-process assistant `content` to remove patterns like `<|channel>…<channel|>`. Prefer fixing server-side parsers instead.

**5. Codex + E2B caveat**

`mlx-community/gemma-4-e2b-it-mxfp4` is convenient on Mac but still emits Codex control tokens through the Slack delivery path. For reliable Slack dev, use **OpenAI** (default overlay) or a larger IT checkpoint with parsers enabled. Track Centaur issues/PRs for response stripping.

## Strict JSON schema (`response_format`)

Gemma 4 structured outputs use OpenAI-style `response_format`:

```python
response_format={
    "type": "json_schema",
    "json_schema": {
        "name": "city-info",
        "schema": {
            "type": "object",
            "properties": {
                "city": {"type": "string"},
                "population": {"type": "integer"},
            },
            "required": ["city", "population"],
        },
    },
}
```

Important details from the vLLM recipe:

- **Constrained decoding enforces shape, not semantics.** Put unit conversions and field meaning in the **system prompt**; `Field(description=…)` is not visible to the model during decoding.
- Use **strict JSON Schema types** (`integer`, `boolean`, `string`, `array` with `items`) — avoid loose `object` blobs when you need reliable fields.
- For integer/boolean fields, if you see whitespace-padding loops, start the server with structured-output options such as `disable_any_whitespace=true` (xgrammar) or upgrade to a vLLM build with repetition detection for schema mode.

The smoke script [`test-local-vllm-gemma4.py`](https://github.com/paradigmxyz/centaur/blob/main/contrib/scripts/test-local-vllm-gemma4.py) includes a minimal `json_schema` check.

## Tool calling smoke test

Minimal OpenAI SDK shape (also what the Python test script exercises):

```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["location"],
        },
    },
}]

response = client.chat.completions.create(
    model="gemma",
    messages=[{"role": "user", "content": "Weather in Tokyo?"}],
    tools=tools,
    max_tokens=512,
    # Prefer stream=False while debugging parser bugs
)
```

Expect `message.tool_calls[0].function.name == "get_weather"` and JSON-parseable `arguments`.

## Reasoning / thinking mode

Enable thinking per request:

```json
{
  "chat_template_kwargs": {"enable_thinking": true},
  "max_tokens": 4096
}
```

With `--reasoning-parser gemma4`, the API exposes thinking in `message.reasoning` (OpenAI SDK) instead of leaking `<|channel>thought\n…<channel|>` into `content`. The test script checks for delimiter leaks when thinking is on.

Default all requests to thinking:

```bash
--default-chat-template-kwargs '{"enable_thinking": true}'
```

## Centaur integration reference

### Environment variables (sandbox pods)

| Variable | Example | Purpose |
| --- | --- | --- |
| `CODEX_USE_VLLM` | `1` | Select `config.vllm.toml` in entrypoint |
| `VLLM_BASE_URL` | `http://host.docker.internal:8000/v1` | OpenAI base URL (must match served name path) |
| `VLLM_API_KEY` | `local` | Placeholder; not sent through iron-proxy |
| `CODEX_MODEL` | `gemma` | Must match `--served-model-name` |
| `NO_PROXY` | `host.docker.internal,host.orb.internal` | Bypass iron-proxy for plain HTTP to host |

`VLLM_BASE_URL` hosts are allowlisted in api-rs (`host.docker.internal`, `host.orb.internal`, `localhost`, `127.0.0.1`). Other hosts are rejected for sandbox egress.

### Codex harness config

[`harness/codex/config.vllm.toml`](https://github.com/paradigmxyz/centaur/blob/main/harness/codex/config.vllm.toml) sets:

```toml
model = "gemma"
model_provider = "vllm"

[model_providers.vllm]
base_url = "http://host.docker.internal:8000/v1"
wire_api = "responses"
requires_openai_auth = false
```

Entrypoint rewrites `model` and `base_url` from `CODEX_MODEL` / `VLLM_BASE_URL` at container start.

### Network policy (dev only)

When `CODEX_USE_VLLM=1` and the base URL is allowlisted, api-rs opens a **port-scoped** egress hole (default TCP/8000) so sandboxes can reach the host gateway. This is intentional for kind/OrbStack dev and must **never** ship to production.

## Troubleshooting

| Check | Command |
| --- | --- |
| Models list | `curl -s http://127.0.0.1:8000/v1/models \| jq .` |
| Full smoke suite | `python3 contrib/scripts/test-local-vllm-gemma4.py` |
| From kind pod | `kubectl run -n centaur curl-test --rm -it --restart=Never --image=curlimages/curl -- curl -sS http://host.docker.internal:8000/v1/models` |
| Sandbox env | `kubectl exec -n centaur <asbx-pod> -- printenv \| grep -E 'VLLM|CODEX_USE'` |

| Problem | Fix |
| --- | --- |
| `Connection refused` from sandbox | Start vLLM on host; verify `host.docker.internal` (or `host.orb.internal`) in `VLLM_BASE_URL` |
| `401` from Codex | vLLM path should not use iron-proxy; confirm `CODEX_USE_VLLM=1` and new sandbox pod |
| Garbled Slack text | Missing parsers, E2B checkpoint, or stale sandbox — see [local Slack dev](/md/local-slack-dev.md) symptom table |
| Tool call never returned | Upgrade vLLM / vllm-mlx; confirm `--tool-call-parser gemma4` |
| JSON schema garbage / loops | `disable_any_whitespace=true`, lower temperature, shorter schema |

## Related

- [Local Slack development](/md/local-slack-dev.md) — tunnel, overlay, end-to-end `@bot` test
- [Configuration](/reference/configuration) — platform env reference
- [vLLM Gemma 4 recipe](https://docs.vllm.ai/projects/recipes/en/latest/Google/Gemma4.html)
- [vLLM Codex integration](https://docs.vllm.ai/en/stable/serving/integrations/codex/)
