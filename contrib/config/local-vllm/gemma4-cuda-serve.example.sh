#!/usr/bin/env bash
# Example upstream vLLM serve line for Gemma 4 on Linux/CUDA.
# Requires vLLM installed (pip/uv) and the tool chat template from the vLLM repo.
#
#   chmod +x contrib/config/local-vllm/gemma4-cuda-serve.example.sh
#   ./contrib/config/local-vllm/gemma4-cuda-serve.example.sh
#
# Or use the wrapper: contrib/scripts/start-local-vllm-gemma4-cuda.sh
set -euo pipefail

MODEL="${VLLM_MODEL:-google/gemma-4-E4B-it}"
SERVED_NAME="${VLLM_SERVED_MODEL_NAME:-gemma}"
PORT="${VLLM_PORT:-8000}"
HOST="${VLLM_HOST:-0.0.0.0}"
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-8192}"

# Resolve chat template: vendored path or vLLM package examples/.
CHAT_TEMPLATE="${VLLM_CHAT_TEMPLATE:-}"
if [[ -z "${CHAT_TEMPLATE}" ]]; then
  for candidate in \
    "examples/tool_chat_template_gemma4.jinja" \
    "$(python3 -c 'import vllm, pathlib; print(pathlib.Path(vllm.__file__).parent / "examples/tool_chat_template_gemma4.jinja")' 2>/dev/null || true)"
  do
    if [[ -n "${candidate}" && -f "${candidate}" ]]; then
      CHAT_TEMPLATE="${candidate}"
      break
    fi
  done
fi

EXTRA=()
if [[ -n "${CHAT_TEMPLATE}" && -f "${CHAT_TEMPLATE}" ]]; then
  EXTRA+=(--chat-template "${CHAT_TEMPLATE}")
else
  echo "warning: tool_chat_template_gemma4.jinja not found; tool calling may be degraded" >&2
fi

exec vllm serve "${MODEL}" \
  --served-model-name "${SERVED_NAME}" \
  --host "${HOST}" --port "${PORT}" \
  --max-model-len "${MAX_MODEL_LEN}" \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4 \
  --override-generation-config '{"eos_token_id":[1,106,50]}' \
  "${EXTRA[@]}"
