#!/usr/bin/env bash
# Start Gemma 4 via upstream vLLM on Linux/CUDA for local Centaur sandboxes.
# API: http://127.0.0.1:8000/v1  (Codex uses --served-model-name gemma)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export VLLM_MODEL="${VLLM_MODEL:-google/gemma-4-E4B-it}"
export VLLM_SERVED_MODEL_NAME="${VLLM_SERVED_MODEL_NAME:-gemma}"
export VLLM_PORT="${VLLM_PORT:-8000}"

if ! command -v vllm >/dev/null 2>&1; then
  echo "vllm not found on PATH. Install upstream vLLM, e.g.:" >&2
  echo "  pip install vllm" >&2
  exit 1
fi

exec "${ROOT}/contrib/config/local-vllm/gemma4-cuda-serve.example.sh"
