#!/usr/bin/env bash
# Start Gemma 4 (E2B) via vllm-mlx for local Centaur sandboxes.
# API: http://127.0.0.1:8000/v1  (Codex uses --served-model-name gemma)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${ROOT}/.local-vllm/.venv"
MODEL="${VLLM_MODEL:-mlx-community/gemma-4-e2b-it-mxfp4}"
SERVED_NAME="${VLLM_SERVED_MODEL_NAME:-gemma}"
PORT="${VLLM_PORT:-8000}"

if [[ ! -x "${VENV}/bin/vllm-mlx" ]]; then
  echo "Missing ${VENV}/bin/vllm-mlx — run:" >&2
  echo "  mkdir -p ${ROOT}/.local-vllm && cd ${ROOT}/.local-vllm" >&2
  echo "  python3.11 -m venv .venv && source .venv/bin/activate && pip install vllm-mlx" >&2
  exit 1
fi

"${ROOT}/contrib/scripts/patch-local-vllm-gemma4.sh"

exec "${VENV}/bin/vllm-mlx" serve "${MODEL}" \
  --served-model-name "${SERVED_NAME}" \
  --host 0.0.0.0 --port "${PORT}" \
  --continuous-batching \
  --enable-auto-tool-choice \
  --tool-call-parser gemma4 \
  --reasoning-parser gemma4
