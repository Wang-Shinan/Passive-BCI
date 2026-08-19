#!/usr/bin/env bash
# TI-ONE entrypoint for offline BFS/MC collect.
# Invoked as: bash this.sh configs/collect_offline.json --depth 3 ...
set -euo pipefail

CFS_ROOT="${CFS_ROOT:-/mnt/cfs-omni}"
ROOT="${CFS_ROOT}/wsn/Passive-BCI/tetris-rl"
LOGDIR="${ROOT}/runs/tione_logs"
SITE="${ROOT}/.venv/lib/python3.12/site-packages"

CONFIG="${1:-configs/collect_offline.json}"
shift || true

unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy || true
export PYTHONUNBUFFERED=1
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export MKL_NUM_THREADS="${MKL_NUM_THREADS:-1}"
export PYTHONPATH="${ROOT}:${SITE}${PYTHONPATH:+:${PYTHONPATH}}"
export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"

mkdir -p "${LOGDIR}" "${ROOT}/runs/offline"
TS="$(date +%Y%m%d_%H%M%S)"
LOG="${LOGDIR}/collect_${TS}.log"
exec > >(tee -a "${LOG}") 2>&1

echo "==== tetris-rl collect config=${CONFIG} host=$(hostname) @ $(date -Is) ===="
echo "TI_TASK_ID=${TI_TASK_ID:-unset}"
echo "args=$*"
nvidia-smi -L || true

cd "${ROOT}"
python3 - <<'PY'
import numpy, torch
import tetris_rl
print(
    f"ok numpy={numpy.__version__} torch={torch.__version__} "
    f"cuda={torch.cuda.is_available()} gpus={torch.cuda.device_count()}"
)
assert torch.cuda.is_available(), "no CUDA"
PY

echo "launch: python3 scripts/collect_offline.py $*"
set +e
python3 scripts/collect_offline.py "$@"
rc=$?
set -e
if [[ "${rc}" -ne 0 ]]; then
  echo "TIONE_COLLECT FAIL rc=${rc} log=${LOG}"
  exit "${rc}"
fi
echo "TIONE_COLLECT OK log=${LOG}"
exit 0
