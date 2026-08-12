#!/usr/bin/env bash
# Sync DEAP / EEGMAT / Workload from COS. STEW is not on COS — see README.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${DATA_ROOT:-$ROOT/data}"
KEY="${1:-all}"

mkdir -p "$DATA"

sync_workload() {
  echo "[sync] Workload zarr"
  mkdir -p "$DATA/workload"
  rclone sync \
    "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/Workload/Workload.zarr" \
    "$DATA/workload/Workload.zarr" \
    --progress
  rclone copy \
    "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/Workload/dataset_config.json" \
    "$DATA/workload/" || true
}

sync_eegmat() {
  echo "[sync] EEGMAT zarr"
  mkdir -p "$DATA/eegmat"
  rclone sync \
    "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/EEGMAT/EEGMAT.zarr" \
    "$DATA/eegmat/EEGMAT.zarr" \
    --progress
  rclone copy \
    "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/EEGMAT/dataset_config.json" \
    "$DATA/eegmat/" || true
  rclone copy \
    "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/EEGMAT/conversion_summary.json" \
    "$DATA/eegmat/" || true
}

sync_deap() {
  echo "[sync] DEAP ratings + (optional) zarr; preprocessed python is large — sync ratings first"
  mkdir -p "$DATA/deap/metadata_csv"
  rclone sync \
    "cos:omni-eeg-1442740494/omni-eeg-01/raw_data/DEAP/metadata_csv" \
    "$DATA/deap/metadata_csv" \
    --progress
  # Binary-valence preprocess (smaller than full python zip) for smoke SVM
  if [[ "${DEAP_FULL:-0}" == "1" ]]; then
    echo "[sync] DEAP data_preprocessed_python.zip (large)"
    rclone copy \
      "cos:omni-eeg-1442740494/omni-eeg-01/raw_data/DEAP/data_preprocessed_python.zip" \
      "$DATA/deap/" \
      --progress
    echo "Unpack manually: unzip data_preprocessed_python.zip -d $DATA/deap/data_preprocessed_python"
  else
    rclone sync \
      "cos:omni-eeg-1442740494/omni-eeg-01/downstream_preprocess/DEAP/DEAP.zarr" \
      "$DATA/deap/DEAP.zarr" \
      --progress
    echo "[hint] For continuous arousal/valence regression set DEAP_FULL=1 to fetch python preprocess zip"
  fi
}

sync_stew() {
  echo "[skip] STEW is NOT on current COS buckets."
  echo "       Download from IEEE DataPort (STEW Dataset) → $DATA/stew/"
  echo "       Then build stew_windows.npz (see README)."
  mkdir -p "$DATA/stew"
}

case "$KEY" in
  workload) sync_workload ;;
  eegmat) sync_eegmat ;;
  deap) sync_deap ;;
  stew) sync_stew ;;
  all)
    sync_workload
    sync_eegmat
    sync_deap
    sync_stew
    ;;
  *)
    echo "usage: $0 [workload|eegmat|deap|stew|all]"
    exit 1
    ;;
esac

echo "Done. Data root: $DATA"
