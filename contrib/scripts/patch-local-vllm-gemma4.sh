#!/usr/bin/env bash
# Apply Gemma 4 weight-loading fixes to the local vllm-mlx venv.
# Gemma 4 checkpoints include KV-shared layer weights that mlx-vlm skips;
# strict loading fails until mlx-vlm forwards strict= to load_weights().
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VENV="${ROOT}/.local-vllm/.venv"
MLX_VLM_UTILS="${VENV}/lib/python3.11/site-packages/mlx_vlm/utils.py"
VLLM_MLLM="${VENV}/lib/python3.11/site-packages/vllm_mlx/models/mllm.py"

if [[ ! -f "${MLX_VLM_UTILS}" ]]; then
  echo "Missing venv at ${VENV}. Create it first:" >&2
  echo "  mkdir -p ${ROOT}/.local-vllm && cd ${ROOT}/.local-vllm" >&2
  echo "  python3.11 -m venv .venv && source .venv/bin/activate" >&2
  echo "  pip install 'vllm-mlx @ git+https://github.com/waybarrios/vllm-mlx.git'" >&2
  exit 1
fi

python3 - "${VENV}" <<'PY'
import pathlib
import sys

venv = pathlib.Path(sys.argv[1])
mlx_utils = venv / "lib/python3.11/site-packages/mlx_vlm/utils.py"
mllm = venv / "lib/python3.11/site-packages/vllm_mlx/models/mllm.py"

text = mlx_utils.read_text()
old = "    model.load_weights(list(weights.items()))"
new = "    model.load_weights(list(weights.items()), strict=kwargs.get(\"strict\", True))"
if old in text:
    mlx_utils.write_text(text.replace(old, new, 1))
    print(f"Patched {mlx_utils}")
elif new in text:
    print(f"Already patched {mlx_utils}")
else:
    print(f"Could not patch {mlx_utils}", file=sys.stderr)
    sys.exit(1)

text = mllm.read_text()
needle = "            self.model, self.processor = load(self.model_name)"
replacement = """            model_lower = self.model_name.lower()
            strict = not ("gemma-4" in model_lower or "gemma4" in model_lower)
            self.model, self.processor = load(self.model_name, strict=strict)"""
if needle in text:
    mllm.write_text(text.replace(needle, replacement, 1))
    print(f"Patched {mllm}")
elif "strict = not (\"gemma-4\" in model_lower" in text:
    print(f"Already patched {mllm}")
else:
    print(f"Could not patch {mllm}", file=sys.stderr)
    sys.exit(1)
PY

echo "Gemma 4 vLLM patches applied."
