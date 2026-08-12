"""SVM classification + calibrated confidence; regression with error-based confidence."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from sklearn.preprocessing import StandardScaler
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    accuracy_score,
    brier_score_loss,
    f1_score,
    mean_absolute_error,
    r2_score,
)
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import Pipeline
from sklearn.svm import SVC, SVR


@dataclass
class FoldResult:
    fold: int
    metrics: dict
    y_true: np.ndarray
    y_pred: np.ndarray
    confidence: np.ndarray
    subjects_test: np.ndarray


def _ece(y_true: np.ndarray, proba: np.ndarray, n_bins: int = 10) -> float:
    """Expected calibration error for multiclass using max-prob confidence."""
    conf = proba.max(axis=1)
    pred = proba.argmax(axis=1)
    correct = (pred == y_true).astype(np.float64)
    bins = np.linspace(0.0, 1.0, n_bins + 1)
    ece = 0.0
    for i in range(n_bins):
        m = (conf >= bins[i]) & (conf < bins[i + 1] if i < n_bins - 1 else conf <= bins[i + 1])
        if not np.any(m):
            continue
        ece += abs(correct[m].mean() - conf[m].mean()) * (m.mean())
    return float(ece)


def run_svm_classification(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    *,
    n_splits: int = 5,
    C: float = 1.0,
    kernel: str = "rbf",
) -> list[FoldResult]:
    """Subject-wise GroupKFold SVM with probability calibration → confidence."""
    uniq = np.unique(groups)
    n_splits = min(n_splits, len(uniq))
    if n_splits < 2:
        raise ValueError("need ≥2 subjects for GroupKFold")

    gkf = GroupKFold(n_splits=n_splits)
    results: list[FoldResult] = []
    for fold, (tr, te) in enumerate(gkf.split(X, y, groups)):
        pipe = Pipeline(
            [
                ("scaler", StandardScaler()),
                (
                    "clf",
                    CalibratedClassifierCV(
                        SVC(C=C, kernel=kernel, class_weight="balanced"),
                        method="sigmoid",
                        cv=3,
                    ),
                ),
            ]
        )
        pipe.fit(X[tr], y[tr])
        proba = pipe.predict_proba(X[te])
        pred = proba.argmax(axis=1)
        conf = proba.max(axis=1)
        metrics = {
            "accuracy": float(accuracy_score(y[te], pred)),
            "macro_f1": float(f1_score(y[te], pred, average="macro")),
            "ece": _ece(y[te], proba),
            "mean_confidence": float(conf.mean()),
            "n_test": int(len(te)),
            "n_subjects_test": int(len(np.unique(groups[te]))),
        }
        # Brier for binary only
        if proba.shape[1] == 2:
            metrics["brier"] = float(brier_score_loss(y[te], proba[:, 1]))
        results.append(
            FoldResult(
                fold=fold,
                metrics=metrics,
                y_true=y[te],
                y_pred=pred,
                confidence=conf,
                subjects_test=groups[te],
            )
        )
    return results


def run_svr_regression(
    X: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    *,
    n_splits: int = 5,
    C: float = 1.0,
) -> list[FoldResult]:
    """Subject-wise SVR; confidence = 1 - |err|/scale (clipped)."""
    uniq = np.unique(groups)
    n_splits = min(n_splits, len(uniq))
    if n_splits < 2:
        raise ValueError("need ≥2 subjects for GroupKFold")

    gkf = GroupKFold(n_splits=n_splits)
    results: list[FoldResult] = []
    y_scale = float(np.std(y) + 1e-6)
    for fold, (tr, te) in enumerate(gkf.split(X, y, groups)):
        pipe = Pipeline(
            [
                ("scaler", StandardScaler()),
                ("reg", SVR(C=C, kernel="rbf")),
            ]
        )
        pipe.fit(X[tr], y[tr])
        pred = pipe.predict(X[te])
        err = np.abs(pred - y[te])
        conf = np.clip(1.0 - err / (2.0 * y_scale), 0.0, 1.0)
        metrics = {
            "mae": float(mean_absolute_error(y[te], pred)),
            "r2": float(r2_score(y[te], pred)),
            "mean_confidence": float(conf.mean()),
            "n_test": int(len(te)),
            "n_subjects_test": int(len(np.unique(groups[te]))),
        }
        results.append(
            FoldResult(
                fold=fold,
                metrics=metrics,
                y_true=y[te],
                y_pred=pred,
                confidence=conf,
                subjects_test=groups[te],
            )
        )
    return results


def summarize(folds: list[FoldResult]) -> dict:
    keys = folds[0].metrics.keys()
    out = {}
    for k in keys:
        if k.startswith("n_"):
            out[k] = int(np.sum([f.metrics[k] for f in folds]))
            continue
        vals = [f.metrics[k] for f in folds]
        out[f"{k}_mean"] = float(np.mean(vals))
        out[f"{k}_std"] = float(np.std(vals))
    return out
