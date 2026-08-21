#!/usr/bin/env bash
# Pull the repo on an H20 (or any CUDA) box, then:
#   cd tetris-rl && ./scripts/run_server.sh
#   ./scripts/run_server.sh configs/ppo_h20.json
#   ./scripts/run_server.sh --smoke
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON="${PYTHON:-python3}"
if [ ! -d .venv ]; then
  "$PYTHON" -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
python -m pip install -U pip
if [ -n "${TORCH_INDEX_URL:-}" ]; then
  python -m pip install torch --index-url "$TORCH_INDEX_URL"
fi
python -m pip install -e ".[dev]"

python - <<'PY'
import torch
print("torch", torch.__version__, "cuda", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu", torch.cuda.get_device_name(0), "count", torch.cuda.device_count())
PY
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi -L || true
fi

export PYTHONUNBUFFERED=1
if [ "${1:-}" = "--smoke" ]; then
  python -m tetris_rl train --algo bc --smoke
  python -m tetris_rl train --algo dqn --smoke
  python -m tetris_rl train --algo ppo --smoke
  python -m tetris_rl train --algo bc_ppo --smoke
elif [ $# -eq 0 ]; then
  python -m tetris_rl sweep --suite configs/sweep_h20.json
elif [ -f "$1" ]; then
  python -m tetris_rl train --config "$1"
else
  python -m tetris_rl "$@"
fi
