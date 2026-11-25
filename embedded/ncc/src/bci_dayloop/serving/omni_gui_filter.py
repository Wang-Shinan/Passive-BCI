"""OmniBCI GUI causal biquad cascade, based on upstream 8dba492."""
from dataclasses import replace
from functools import lru_cache
from math import cos, pi, sin
from typing import TypedDict

import numpy as np

from .protocol import ParsedWindow

OMNI_GUI_FILTER_ALGORITHM = 'omni_gui'


class CustomFilter(TypedDict):
    lowHz: float
    highHz: float
    useNotch: bool


@lru_cache(maxsize=8)
def _sections(sample_rate: float, low_hz: float, high_hz: float, notch: bool) -> np.ndarray:
    high_hz = min(high_hz, sample_rate / 2 - 0.5)
    low_hz = max(0.05, min(low_hz, high_hz - 0.5))
    stages = [(low_hz, 'high', .707), (high_hz, 'low', .707)]
    if notch:
        stages.extend(((50, 'notch', 30), (100, 'notch', 30)))
    sections = []
    for edge, response, q in stages:
        if edge <= 0 or edge >= sample_rate / 2:
            continue
        angle = 2 * pi * edge / sample_rate
        cosine = cos(angle)
        alpha = sin(angle) / (2 * q)
        if response == 'notch':
            side, middle = 1.0, -2 * cosine
        elif response == 'high':
            side = (1 + cosine) / 2
            middle = -2 * side
        else:
            side = (1 - cosine) / 2
            middle = 2 * side
        divisor = 1 + alpha
        sections.append((side / divisor, middle / divisor, side / divisor, 1,
                         -2 * cosine / divisor, (1 - alpha) / divisor))
    return np.asarray(sections, dtype=np.float64).reshape(-1, 6)


class OmniGuiCausalFilter:
    def __init__(self, sample_rate: float, settings: CustomFilter) -> None:
        from scipy.signal import sosfilt_zi

        self.sos = _sections(sample_rate, settings['lowHz'], settings['highHz'], settings['useNotch'])
        self.unit_initial = sosfilt_zi(self.sos) if len(self.sos) else None
        self.state = None

    def apply(self, data: np.ndarray) -> np.ndarray:
        from scipy.signal import sosfilt

        if not data.shape[-1] or self.unit_initial is None:
            return data
        if self.state is None:
            self.state = self.unit_initial[:, None, :] * data[None, :, 0, None]
        filtered, self.state = sosfilt(self.sos, data, axis=-1, zi=self.state)
        return filtered.astype(np.float32)


class OmniGuiWindowFilter:
    """Filter new samples once and reuse the overlap, independently per live source."""

    def __init__(self, settings: CustomFilter) -> None:
        self.settings = settings
        self.key = None
        self.end = None
        self.previous = None
        self.filter = None

    def apply(self, window: ParsedWindow) -> ParsedWindow:
        rate = window.sample_rate
        end = round(window.end_time_sec * rate) if window.end_time_sec is not None else None
        start = end - window.samples if end is not None else None
        key = (window.segment_id, rate, window.channel_names, window.reported_missing_samples_total)
        overlap = 0
        if (key == self.key and start is not None and self.end is not None and self.previous is not None
            and end > self.end and self.end - self.previous.shape[1] <= start <= self.end):
            overlap = self.end - start
        else:
            self.filter = OmniGuiCausalFilter(rate, self.settings)
        filtered = self.filter.apply(window.data[:, overlap:])
        if overlap:
            filtered = np.concatenate((self.previous[:, -overlap:], filtered), axis=1)
        self.key, self.end, self.previous = key, end, filtered
        return replace(window, data=filtered, omni_gui_filtered=True)
