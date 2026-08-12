"""Band-power features aligned with src/lib/features (browser pipeline)."""

from __future__ import annotations

import numpy as np

BANDS = {
    "delta": (1.0, 4.0),
    "theta": (4.0, 8.0),
    "alpha": (8.0, 13.0),
    "beta": (13.0, 30.0),
    "gamma": (30.0, 45.0),
}

EPS = 1e-12


def _welch_psd(x: np.ndarray, sfreq: float) -> tuple[np.ndarray, np.ndarray]:
    """Return (freqs, psd) for 1-D signal using numpy rFFT (Hann window)."""
    n = x.size
    if n < 16:
        return np.array([0.0]), np.array([0.0])
    x = x - np.mean(x)
    window = np.hanning(n)
    # next pow2
    nfft = 1 << int(np.ceil(np.log2(max(n, 16))))
    spec = np.fft.rfft(x * window, n=nfft)
    psd = (np.abs(spec) ** 2) * 2.0 / (sfreq * (np.sum(window**2) + EPS))
    psd[0] *= 0.5
    if nfft % 2 == 0:
        psd[-1] *= 0.5
    freqs = np.fft.rfftfreq(nfft, d=1.0 / sfreq)
    return freqs, psd


def band_powers_channel(x: np.ndarray, sfreq: float) -> dict[str, float]:
    freqs, psd = _welch_psd(x.astype(np.float64), sfreq)
    out: dict[str, float] = {}
    for name, (lo, hi) in BANDS.items():
        mask = (freqs >= lo) & (freqs < hi)
        out[name] = float(np.sum(psd[mask])) if np.any(mask) else 0.0
    return out


def relative_bands(abs_bands: dict[str, float]) -> dict[str, float]:
    total = sum(abs_bands.values()) + EPS
    return {k: v / total for k, v in abs_bands.items()}


def neuroskill_scores(rel: dict[str, float]) -> dict[str, float]:
    """Same formulas as src/lib/features/bandFeatures.ts."""
    delta = rel.get("delta", 0.0)
    theta = rel.get("theta", 0.0)
    alpha = rel.get("alpha", 0.0)
    beta = rel.get("beta", 0.0)
    engagement = beta / (alpha + theta + EPS)
    relaxation = alpha / (beta + theta + EPS)
    cognitive_load = theta / (alpha + EPS)
    drowsiness = (theta + delta) / (alpha + beta + EPS)
    return {
        "focus_score": engagement,
        "engagement_score": engagement,
        "relaxation_score": relaxation,
        "cognitive_load": cognitive_load,
        "drowsiness": drowsiness,
        "tbr_theta_beta": theta / (beta + EPS),
        "tar_theta_alpha": theta / (alpha + EPS),
        "bar_beta_alpha": beta / (alpha + EPS),
    }


def extract_window_features(eeg: np.ndarray, sfreq: float) -> np.ndarray:
    """
    eeg: shape (n_channels, n_times)
    Returns 1-D feature vector: channel-mean rel bands (5) + scores (8) + rms.
    """
    if eeg.ndim != 2:
        raise ValueError(f"expected (C,T), got {eeg.shape}")
    c, t = eeg.shape
    if t < 16:
        return np.zeros(5 + 8 + 1, dtype=np.float64)

    acc = {k: 0.0 for k in BANDS}
    rms_acc = 0.0
    for ch in range(c):
        x = eeg[ch]
        if not np.any(np.isfinite(x)):
            continue
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
        bp = band_powers_channel(x, sfreq)
        for k, v in bp.items():
            acc[k] += v
        rms_acc += float(np.sqrt(np.mean(x * x) + EPS))
    acc = {k: v / max(c, 1) for k, v in acc.items()}
    rel = relative_bands(acc)
    scores = neuroskill_scores(rel)
    vec = (
        [rel[k] for k in ("delta", "theta", "alpha", "beta", "gamma")]
        + [
            scores["focus_score"],
            scores["engagement_score"],
            scores["relaxation_score"],
            scores["cognitive_load"],
            scores["drowsiness"],
            scores["tbr_theta_beta"],
            scores["tar_theta_alpha"],
            scores["bar_beta_alpha"],
        ]
        + [rms_acc / max(c, 1)]
    )
    return np.asarray(vec, dtype=np.float64)


FEATURE_NAMES = [
    "rel_delta",
    "rel_theta",
    "rel_alpha",
    "rel_beta",
    "rel_gamma",
    "focus_score",
    "engagement_score",
    "relaxation_score",
    "cognitive_load",
    "drowsiness",
    "tbr",
    "tar",
    "bar",
    "rms",
]
