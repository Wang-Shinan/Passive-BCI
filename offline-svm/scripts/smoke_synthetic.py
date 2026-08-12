#!/usr/bin/env python3
"""Synthetic smoke test — no COS required."""

from __future__ import annotations

import numpy as np

from offline_svm.bands import extract_window_features
from offline_svm.models import run_svm_classification, summarize


def main() -> None:
    rng = np.random.default_rng(0)
    X, y, g = [], [], []
    for subj in range(8):
        for _ in range(40):
            # class-conditional band mix
            lab = subj % 3
            eeg = rng.normal(0, 1, size=(16, 400))
            t = np.arange(400) / 200.0
            if lab == 0:
                eeg += 0.8 * np.sin(2 * np.pi * 10 * t)  # alpha
            elif lab == 1:
                eeg += 0.8 * np.sin(2 * np.pi * 6 * t)  # theta
            else:
                eeg += 0.8 * np.sin(2 * np.pi * 20 * t)  # beta
            X.append(extract_window_features(eeg, 200.0))
            y.append(lab)
            g.append(f"s{subj}")
    X = np.stack(X)
    y = np.asarray(y)
    g = np.asarray(g, dtype=object)
    folds = run_svm_classification(X, y, g, n_splits=4)
    print(summarize(folds))
    assert summarize(folds)["accuracy_mean"] > 0.4


if __name__ == "__main__":
    main()
