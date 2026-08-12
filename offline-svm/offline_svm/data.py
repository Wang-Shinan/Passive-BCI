"""Load downstream zarr windows (Workload / EEGMAT / DEAP preprocess)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .bands import extract_window_features


@dataclass
class WindowDataset:
    X: np.ndarray  # (n, n_features)
    y: np.ndarray  # (n,) int or float
    subject_ids: np.ndarray  # (n,) str
    feature_names: list[str]
    meta: dict


def _open_zarr(path: Path):
    import zarr

    return zarr.open(str(path), mode="r")


def load_zarr_classification(
    zarr_path: Path | str,
    *,
    sfreq: float = 200.0,
    max_samples: int | None = None,
    min_channels: int = 8,
) -> WindowDataset:
    """
    Expect schema:
      signals: (n, C, T) or chunked
      labels: (n,)
      subject_ids: (n,) optional
      channel_mask / channel_counts optional
    """
    from .bands import FEATURE_NAMES

    root = _open_zarr(Path(zarr_path))
    signals = root["signals"]
    labels = np.asarray(root["labels"][:], dtype=np.int32)
    n = int(labels.shape[0])
    if max_samples is not None:
        n = min(n, max_samples)

    if "subject_ids" in root:
        subjects = np.asarray(root["subject_ids"][:n])
        subjects = np.array([str(s) for s in subjects], dtype=object)
    else:
        subjects = np.array([f"sub{i:04d}" for i in range(n)], dtype=object)

    feats = []
    y = []
    sid = []
    for i in range(n):
        eeg = np.asarray(signals[i], dtype=np.float64)
        if eeg.ndim == 1:
            continue
        # some stores pad channels; drop empty
        if "channel_mask" in root:
            mask = np.asarray(root["channel_mask"][i]).astype(bool)
            if mask.size == eeg.shape[0]:
                eeg = eeg[mask]
        if eeg.shape[0] < min_channels:
            continue
        feats.append(extract_window_features(eeg, sfreq))
        y.append(int(labels[i]))
        sid.append(subjects[i])

    return WindowDataset(
        X=np.stack(feats, axis=0) if feats else np.zeros((0, len(FEATURE_NAMES))),
        y=np.asarray(y, dtype=np.int32),
        subject_ids=np.asarray(sid, dtype=object),
        feature_names=list(FEATURE_NAMES),
        meta={"source": str(zarr_path), "n_raw": int(labels.shape[0]), "n_used": len(y)},
    )


def load_deap_preprocessed_python(
    dat_dir: Path | str,
    ratings_csv: Path | str | None = None,
    *,
    target: str = "arousal",
    sfreq: float = 128.0,
    window_sec: float = 4.0,
    hop_sec: float = 2.0,
    max_subjects: int | None = None,
) -> WindowDataset:
    """
    Load DEAP `data_preprocessed_python` .dat files.

    Each file: dict with
      data: (40 trials, 40 channels, 8064) — first 32 EEG
      labels: (40, 4) valence, arousal, dominance, liking
    """
    import pickle

    from .bands import FEATURE_NAMES

    dat_dir = Path(dat_dir)
    files = sorted(dat_dir.glob("s*.dat"))
    if max_subjects is not None:
        files = files[:max_subjects]
    if not files:
        raise FileNotFoundError(f"no s*.dat under {dat_dir}")

    target_idx = {"valence": 0, "arousal": 1, "dominance": 2, "liking": 3}[target]
    win = int(window_sec * sfreq)
    hop = int(hop_sec * sfreq)

    feats, y, sid = [], [], []
    for fp in files:
        with open(fp, "rb") as f:
            raw = pickle.load(f, encoding="latin1")
        data = np.asarray(raw["data"], dtype=np.float64)  # (40, 40, T)
        labels = np.asarray(raw["labels"], dtype=np.float64)  # (40, 4)
        subj = fp.stem
        n_trials = data.shape[0]
        for tr in range(n_trials):
            eeg = data[tr, :32, :]  # EEG only
            # skip baseline first 3s if present (DEAP preprocessed includes baseline)
            # common practice: use last 60s → drop first 3*128=384 samples
            if eeg.shape[1] >= 8064:
                eeg = eeg[:, 384:]
            t = eeg.shape[1]
            score = float(labels[tr, target_idx])
            for start in range(0, max(1, t - win + 1), hop):
                seg = eeg[:, start : start + win]
                if seg.shape[1] < win:
                    break
                feats.append(extract_window_features(seg, sfreq))
                y.append(score)
                sid.append(subj)

    return WindowDataset(
        X=np.stack(feats, axis=0),
        y=np.asarray(y, dtype=np.float64),
        subject_ids=np.asarray(sid, dtype=object),
        feature_names=list(FEATURE_NAMES),
        meta={"source": str(dat_dir), "target": target, "n_files": len(files)},
    )


def load_stew(
    root: Path | str,
    *,
    sfreq: float = 128.0,
    window_sec: float = 4.0,
    hop_sec: float = 2.0,
) -> WindowDataset:
    """
    STEW expected layout (after manual download):

      data/stew/
        ratings.txt or ratings.csv   # subject, condition, rating
        *.eeg / *.edf / *.mat        # per-subject recordings

    Raises FileNotFoundError with instructions if missing.
    """
    root = Path(root)
    if not root.exists():
        raise FileNotFoundError(
            f"STEW not found at {root}. Dataset is not on current COS; "
            "download from IEEE DataPort (STEW) and place files under data/stew/."
        )
    # Minimal: if user provides a prepared npz
    npz = root / "stew_windows.npz"
    if npz.exists():
        from .bands import FEATURE_NAMES

        z = np.load(npz, allow_pickle=True)
        return WindowDataset(
            X=z["X"],
            y=z["y"],
            subject_ids=z["subject_ids"],
            feature_names=list(FEATURE_NAMES),
            meta={"source": str(npz)},
        )
    raise FileNotFoundError(
        f"STEW directory exists at {root} but no stew_windows.npz yet. "
        "Convert rest vs SIMKAP recordings into windows and save "
        "X,y,subject_ids via scripts/prepare_stew.py (TODO)."
    )
