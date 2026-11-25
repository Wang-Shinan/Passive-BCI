"""Preprocessing for the imported S04 2026-10-15 four-second REVE model.

The checkpoint mode applies the training MNE operations within each available
window. Other filter modes use the same montage and normalization.
"""
from __future__ import annotations

from typing import Sequence
import numpy as np
from bci_dayloop.serving.reve_filter import CustomFilter, apply_reve_custom_band, apply_reve_pretraining_band
from bci_dayloop.serving.omni_gui_filter import OmniGuiCausalFilter

PROFILE = 's04-mne-4s-v1'


def prepare_s04_window(data: np.ndarray, channel_names: Sequence[str],
                       sample_rate: float, required_names: Sequence[str], *,
                       window_sec: float = 4, filter_mode: str = "checkpoint",
                       custom_filter: CustomFilter | None = None,
                       omni_gui_settings: CustomFilter | None = None,
                       omni_gui_filtered: bool = False) -> tuple[np.ndarray, tuple[str, ...]]:
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
    if omni_gui_settings is not None and not omni_gui_filtered:
        selected = OmniGuiCausalFilter(sample_rate, omni_gui_settings).apply(selected)
    elif omni_gui_settings is None and filter_mode == 'custom' and custom_filter is not None:
        selected = apply_reve_custom_band(selected, sample_rate, custom_filter)
    obj = mne.io.RawArray(selected * 1e-6, mne.create_info(list(names), sample_rate, 'eeg'), verbose='ERROR')
    if sample_rate != 200:
        obj.resample(200, verbose='ERROR')
    if filter_mode == "checkpoint":
        obj.filter(.5, 40, verbose='ERROR', skip_by_annotation='edge')
        obj.notch_filter(50, verbose='ERROR')
    x = obj.get_data() * 1e6
    if filter_mode == "pretraining" and omni_gui_settings is None:
        x = apply_reve_pretraining_band(x, 200.0)
    x = x.astype(np.float32)
    expected = (31, int(window_sec * 200))
    if x.shape != expected:
        raise ValueError(f'S04 preprocessing produced {x.shape}, expected {expected}')
    # Match train.py: population variance + epsilon inside the square root.
    x = (x - x.mean(axis=-1, keepdims=True)) / np.sqrt(x.var(axis=-1, keepdims=True) + 1e-6)
    return np.clip(x, -15, 15), names
