"""Optional REVE input band-pass, in model-sample coordinates."""
from functools import lru_cache
from math import gcd, isfinite

import numpy as np
from .omni_gui_filter import CustomFilter

REVE_FILTER_MODES = ("pretraining", "none", "checkpoint", "custom")
DEFAULT_REVE_FILTER = "pretraining"
DEFAULT_REVE_BAND: CustomFilter = {"lowHz": 0.5, "highHz": 99.5, "useNotch": True}
LEGACY_REVE_BAND: CustomFilter = {**DEFAULT_REVE_BAND, "useNotch": False}


def validate_custom_filter(value: object) -> CustomFilter:
    if not isinstance(value, dict):
        raise ValueError("Custom REVE filter settings are required")
    low, high, notch = (value.get(key) for key in ("lowHz", "highHz", "useNotch"))
    if (type(low) not in (int, float) or type(high) not in (int, float)
        or not isfinite(low) or not isfinite(high)
        or not 0.05 <= low <= 30 or not low + 0.5 <= high <= 99.5
        or not isinstance(notch, bool)):
        raise ValueError("Invalid custom REVE filter settings")
    return {"lowHz": float(low), "highHz": float(high), "useNotch": notch}


@lru_cache(maxsize=8)
def _pretraining_sos(sample_rate: float) -> np.ndarray:
    from scipy.signal import butter

    if sample_rate <= 199.0:
        raise ValueError("REVE 0.5–99.5 Hz band-pass requires a model sampling rate above 199 Hz")
    return butter(4, (0.5, 99.5), btype="bandpass", fs=sample_rate, output="sos")


def resample_reve_band_input(data: np.ndarray, samples: int) -> np.ndarray:
    from scipy.signal import resample_poly

    current = data.shape[-1]
    if current == samples:
        return data
    common = gcd(current, samples)
    return resample_poly(data, samples // common, current // common, axis=-1, padtype="line")


def apply_reve_pretraining_band(data: np.ndarray, sample_rate: float) -> np.ndarray:
    from scipy.signal import sosfiltfilt

    # Work within the current inference window, with reflected edges.
    return sosfiltfilt(_pretraining_sos(sample_rate), data, axis=-1, padlen=min(27, data.shape[-1] - 1))


@lru_cache(maxsize=32)
def _custom_sos(sample_rate: float, low: float, high: float, notch: bool) -> np.ndarray:
    from scipy.signal import butter, iirnotch, tf2sos

    limit = sample_rate / 2 - 0.5
    low = min(low, limit - 0.5)
    hi = min(high, limit)
    if low < 0.05:
        raise ValueError("Sample rate is too low for a custom REVE band-pass")
    sections = [butter(2, (low, hi), btype="bandpass", fs=sample_rate, output="sos")]
    if notch:
        for hz in (50, 100):
            if hz < sample_rate / 2:
                sections.append(tf2sos(*iirnotch(hz, 30, fs=sample_rate)))
    return np.vstack(sections)


def apply_reve_custom_band(data: np.ndarray, sample_rate: float, custom: CustomFilter) -> np.ndarray:
    from scipy.signal import sosfiltfilt

    sos = _custom_sos(sample_rate, custom["lowHz"], custom["highHz"], custom["useNotch"])
    return sosfiltfilt(sos, data, axis=-1, padlen=min(3 * (2 * len(sos) + 1), data.shape[-1] - 1))
