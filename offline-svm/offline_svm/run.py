#!/usr/bin/env python3
"""CLI: offline SVM / regression on DEAP, STEW, EEGMAT, Workload."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from offline_svm.data import (
    load_deap_preprocessed_python,
    load_stew,
    load_zarr_classification,
)
from offline_svm.models import run_svm_classification, run_svr_regression, summarize
from offline_svm.registry import DATASETS, list_datasets


def _data_root(args: argparse.Namespace) -> Path:
    return Path(args.data_root).expanduser().resolve()


def load_dataset(key: str, root: Path, args: argparse.Namespace):
    spec = DATASETS[key]
    local = root / spec.local_subdir

    if key == "workload":
        zarr_path = local / "Workload.zarr"
        if not zarr_path.exists():
            raise FileNotFoundError(
                f"Missing {zarr_path}. Run: bash scripts/sync_cos.sh workload"
            )
        return load_zarr_classification(
            zarr_path, sfreq=spec.sfreq, max_samples=args.max_samples
        )

    if key == "eegmat":
        zarr_path = local / "EEGMAT.zarr"
        if not zarr_path.exists():
            raise FileNotFoundError(
                f"Missing {zarr_path}. Run: bash scripts/sync_cos.sh eegmat"
            )
        return load_zarr_classification(
            zarr_path, sfreq=spec.sfreq, max_samples=args.max_samples
        )

    if key == "deap":
        dat_dir = local / "data_preprocessed_python"
        if dat_dir.exists() and any(dat_dir.glob("s*.dat")):
            return load_deap_preprocessed_python(
                dat_dir,
                target=args.deap_target,
                max_subjects=args.max_subjects,
            )
        zarr_path = local / "DEAP.zarr"
        if zarr_path.exists():
            print(
                "[warn] using DEAP.zarr binary valence labels; "
                "prefer data_preprocessed_python for continuous V/A/D/Liking"
            )
            return load_zarr_classification(
                zarr_path, sfreq=200.0, max_samples=args.max_samples
            )
        raise FileNotFoundError(
            f"DEAP not found under {local}. "
            "Run: bash scripts/sync_cos.sh deap  (or DEAP_FULL=1 for .dat)"
        )

    if key == "stew":
        return load_stew(local)

    raise KeyError(key)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "dataset",
        choices=[*DATASETS.keys(), "all", "list"],
        help="dataset key, 'all' (COS-available), or 'list'",
    )
    p.add_argument(
        "--data-root",
        default="data",
        help="local mirror root (default: ./data)",
    )
    p.add_argument("--out", default="results", help="output directory")
    p.add_argument("--max-samples", type=int, default=None)
    p.add_argument("--max-subjects", type=int, default=None)
    p.add_argument("--n-splits", type=int, default=5)
    p.add_argument(
        "--deap-target",
        default="arousal",
        choices=("valence", "arousal", "dominance", "liking"),
    )
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args()

    if args.dataset == "list":
        for s in list_datasets():
            flag = "COS" if s.available_on_cos else "LOCAL-ONLY"
            print(
                f"{s.key:10} [{flag}] {s.display_name} · {s.dimension} · "
                f"{s.task} · maps→{','.join(s.maps_to)}"
            )
            print(f"           {s.notes}")
        return

    keys = (
        [s.key for s in list_datasets(cos_only=True)]
        if args.dataset == "all"
        else [args.dataset]
    )
    # allow stew explicitly even if missing
    if args.dataset == "stew":
        keys = ["stew"]

    root = _data_root(args)
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    np.random.seed(args.seed)

    summary_all = {}
    for key in keys:
        spec = DATASETS[key]
        print(f"\n=== {spec.display_name} ({key}) ===")
        try:
            ds = load_dataset(key, root, args)
        except FileNotFoundError as e:
            print(f"[skip] {e}")
            summary_all[key] = {"status": "missing", "error": str(e)}
            continue

        print(
            f"loaded X={ds.X.shape} y={ds.y.shape} subjects={len(np.unique(ds.subject_ids))} "
            f"meta={ds.meta}"
        )
        if ds.X.shape[0] < 10:
            summary_all[key] = {"status": "too_few", "meta": ds.meta}
            continue

        if spec.task == "classification" or (
            key == "deap" and ds.y.dtype.kind in "iu"
        ):
            # optional: bin continuous DEAP for SVM
            y = ds.y
            if y.dtype.kind == "f":
                # median split for quick SVM smoke; full regression below too
                med = float(np.median(y))
                y_cls = (y >= med).astype(np.int32)
                folds = run_svm_classification(
                    ds.X, y_cls, ds.subject_ids, n_splits=args.n_splits
                )
                reg_folds = run_svr_regression(
                    ds.X, y, ds.subject_ids, n_splits=args.n_splits
                )
                summary = {
                    "status": "ok",
                    "classification": summarize(folds),
                    "regression": summarize(reg_folds),
                    "target": getattr(args, "deap_target", None),
                    "meta": ds.meta,
                }
            else:
                folds = run_svm_classification(
                    ds.X, y, ds.subject_ids, n_splits=args.n_splits
                )
                summary = {
                    "status": "ok",
                    "classification": summarize(folds),
                    "meta": ds.meta,
                    "label_names": list(spec.label_names),
                }
        else:
            folds = run_svr_regression(
                ds.X, ds.y, ds.subject_ids, n_splits=args.n_splits
            )
            summary = {
                "status": "ok",
                "regression": summarize(folds),
                "meta": ds.meta,
            }

        summary_all[key] = summary
        out_path = out_root / f"{key}_summary.json"
        out_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
        print(json.dumps(summary, indent=2))

    (out_root / "summary_all.json").write_text(
        json.dumps(summary_all, indent=2), encoding="utf-8"
    )
    print(f"\nWrote {out_root / 'summary_all.json'}")


if __name__ == "__main__":
    main()
