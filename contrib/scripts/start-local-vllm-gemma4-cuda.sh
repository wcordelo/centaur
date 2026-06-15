#!/usr/bin/env bash
# Start Gemma 4 via upstream vLLM on Linux/CUDA for local Centaur sandboxes.
# API: http://127.0.0.1:8000/v1  (Codex uses --served-model-name gemma)
#
# Requires a Gemma-4-capable vLLM build (nightly or gemma4-tagged image).
# See docs/public/md/local-model-development.md
set -euo pipefail

MODEL="${VLLM_MODEL:-google/gemma-4-E4B-it}"
SERVED_NAME="${VLLM_SERVED_MODEL_NAME:-gemma}"
PORT="${VLLM_PORT:-8000}"
HOST="${VLLM_HOST:-0.0.0.0}"
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-8192}"
GPU_MEM="${VLLM_GPU_MEMORY_UTILIZATION:-0.90}"
CHAT_TEMPLATE="${VLLM_CHAT_TEMPLATE:-examples/tool_chat_template_gemma4.jinja}"

if ! command -v vllm >/dev/null 2>&1; then
  echo "vllm CLI not found. Install vLLM with Gemma 4 support, e.g.:" >&2
  echo "  uv venv && source .venv/bin/activate" >&2
  echo "  uv pip install -U vllm --pre --extra-index-url https://wheels.vllm.ai/nightly/cu129" >&2
  exit 1
fi

ARGS=(
  serve "${MODEL}"
  --served-model-name "${SERVED_NAME}"
  --host "${HOST}" --port "${PORT}"
  --max-model-len "${MAX_MODEL_LEN}"
  --gpu-memory-utilization "${GPU_MEM}"
  --enable-auto-tool-choice
  --tool-call-parser gemma4
  --reasoning-parser gemma4
)

if [[ -n "${CHAT_TEMPLATE}" ]]; then
  ARGS+=(--chat-template "${CHAT_TEMPLATE}")
fi

if [[ "${VLLM_STRUCTURED_OUTPUT_DISABLE_ANY_WHITESPACE:-0}" == "1" ]]; then
  ARGS+=(--structured-outputs-config '{"disable_any_whitespace": true}')
fi

if [[ -n "${VLLM_EXTRA_ARGS:-}" ]]; then
  # shellcheck disable=SC2206
  EXTRA=( ${VLLM_EXTRA_ARGS} )
  ARGS+=("${EXTRA[@]}")
fi

echo "Starting vLLM: ${MODEL} as ${SERVED_NAME} on ${HOST}:${PORT}" >&2
exec vllm "${ARGS[@]}"
