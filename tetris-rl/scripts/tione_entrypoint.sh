#!/usr/bin/env bash
# TI-ONE entrypoint for tetris-rl.
# Invoked as: bash this.sh configs/bc_h20.json --run-name ...
set -euo pipefail

CFS_ROOT="${CFS_ROOT:-/mnt/cfs-omni}"
ROOT="${CFS_ROOT}/wsn/Passive-BCI/tetris-rl"
LOGDIR="${ROOT}/runs/tione_logs"
SITE="${ROOT}/.venv/lib/python3.12/site-packages"

CONFIG="${1:-configs/bc_h20.json}"
shift || true

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true
export PYTHONUNBUFFERED=1
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"
export PYTHONPATH="${ROOT}:${SITE}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

mkdir -p "${LOGDIR}"
TS="$(date +%Y%m%d_%H%M%S)"
CFG_BASE="$(basename "${CONFIG}" .json)"
LOG="${LOGDIR}/${CFG_BASE}_${TS}.log"
exec > >(tee -a "${LOG}") 2>&1

echo "==== tetris-rl tione config=${CONFIG} host=$(hostname) @ $(date -Is) ===="
echo "TI_TASK_ID=${TI_TASK_ID:-unset}"
echo "args=$*"
nvidia-smi -L || true

cd "${ROOT}"
if [[ ! -f "${CONFIG}" ]]; then
  echo "MISS config: ${ROOT}/${CONFIG}" >&2
  exit 2
fi

python3 - <<'PY'
import gymnasium, numpy, torch
import tetris_rl
print(
    f"ok gymnasium={gymnasium.__version__} numpy={numpy.__version__} "
    f"torch={torch.__version__} cuda={torch.cuda.is_available()} "
    f"gpus={torch.cuda.device_count()}"
)
assert torch.cuda.is_available(), "no CUDA"
PY

echo "launch: python3 -m tetris_rl train --config ${CONFIG} $*"
set +e
python3 -m tetris_rl train --config "${CONFIG}" "$@"
rc=$?
set -e
if [[ "${rc}" -ne 0 ]]; then
  echo "TIONE_TRAIN FAIL rc=${rc} log=${LOG}"
  exit "${rc}"
fi
echo "TIONE_TRAIN OK log=${LOG}"
exit 0
