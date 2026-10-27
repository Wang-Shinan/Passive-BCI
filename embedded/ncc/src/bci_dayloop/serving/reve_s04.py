"""Preprocessing for the imported S04 2026-10-15 four-second REVE model.

Training filtered entire recordings with zero-phase FIR. Serving uses the same
MNE operations on each available window (reflected boundaries, no future EEG).
The boundary approximation must be evaluated separately from offline training.
"""
from __future__ import annotations

from typing import Sequence
import numpy as np

PROFILE = 's04-mne-4s-v1'


def prepare_s04_window(data: np.ndarray, channel_names: Sequence[str],
                       sample_rate: float, required_names: Sequence[str], *, window_sec: float = 4) -> tuple[np.ndarray, tuple[str, ...]]:
    import mne

    names = tuple(required_names)
    if len(names) != 31 or len(set(names)) != 31 or len(set(channel_names)) != len(channel_names):
        raise ValueError('S04 model requires 31 distinct EEG electrode names')
    missing = set(names) - set(channel_names)
    if missing:
        raise ValueError('S04 model is missing trained electrodes: ' + ', '.join(sorted(missing)))
    if window_sec not in (2, 4) or abs(data.shape[1] / sample_rate - window_sec) > 1 / sample_rate:
        raise ValueError(f'S04 model requires a {window_sec:g}-second window')
    selected = np.asarray(data[[channel_names.index(name) for name in names]], dtype=np.float64)
    obj = mne.io.RawArray(selected * 1e-6, mne.create_info(list(names), sample_rate, 'eeg'), verbose='ERROR')
    if sample_rate != 200:
        obj.resample(200, verbose='ERROR')
    obj.filter(.5, 40, verbose='ERROR', skip_by_annotation='edge')
    obj.notch_filter(50, verbose='ERROR')
    x = (obj.get_data() * 1e6).astype(np.float32)
    expected = (31, int(window_sec * 200))
    if x.shape != expected:
        raise ValueError(f'S04 preprocessing produced {x.shape}, expected {expected}')
    # Match train.py: population variance + epsilon inside the square root.
    x = (x - x.mean(axis=-1, keepdims=True)) / np.sqrt(x.var(axis=-1, keepdims=True) + 1e-6)
    return np.clip(x, -15, 15), names
