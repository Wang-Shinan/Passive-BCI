#!/usr/bin/env bash
# Run on a machine with COS mount (or after syncing data locally on that box).
# Does NOT download large datasets to a laptop — expects mount paths from remote_paths.yaml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DATASET="${1:-list}"
DATA_ROOT="${DATA_ROOT:-$ROOT/data}"
OUT="${OUT:-$ROOT/results}"
MOUNT_ROOT="${MOUNT_ROOT:-/mnt/omni-eeg-01}"

mkdir -p "$DATA_ROOT" "$OUT"

link_if_missing() {
  local src="$1" dst="$2"
  if [[ -e "$dst" ]]; then
    return 0
  fi
  if [[ -e "$src" ]]; then
    mkdir -p "$(dirname "$dst")"
    ln -sfn "$src" "$dst"
    echo "[link] $dst -> $src"
  else
    echo "[warn] missing mount path: $src"
  fi
}

# Prefer in-place mount symlinks so offline_svm.run's data/<ds>/*.zarr layout works
link_if_missing "$MOUNT_ROOT/downstream_preprocess/Workload/Workload.zarr" \
  "$DATA_ROOT/workload/Workload.zarr"
link_if_missing "$MOUNT_ROOT/downstream_preprocess/EEGMAT/EEGMAT.zarr" \
  "$DATA_ROOT/eegmat/EEGMAT.zarr"
link_if_missing "$MOUNT_ROOT/downstream_preprocess/DEAP/DEAP.zarr" \
  "$DATA_ROOT/deap/DEAP.zarr"
link_if_missing "$MOUNT_ROOT/raw_data/DEAP/metadata_csv" \
  "$DATA_ROOT/deap/metadata_csv"

export PYTHONPATH="$ROOT${PYTHONPATH:+:$PYTHONPATH}"
python -m offline_svm.run "$DATASET" --data-root "$DATA_ROOT" --out "$OUT" "${@:2}"
