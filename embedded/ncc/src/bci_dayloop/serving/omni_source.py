"""ESP32 SDK batches -> continuous model windows, without browser or LSL transport."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
import uuid

import numpy as np

from .protocol import ParsedWindow, validate_electrode_positions


@dataclass(frozen=True)
class OmniSourceConfig:
    endpoint: str
    channel_names: tuple[str, ...]
    max_age_sec: float = 1.0
    idle_timeout_sec: float = 5.0
    relay: bool = False
    electrode_names: tuple[str, ...] | None = None
    electrode_positions: tuple[tuple[float, float, float], ...] | None = None

    def __post_init__(self) -> None:
        if not self.endpoint.startswith(("ble://", "serial://")) or not self.endpoint.split("://", 1)[1]:
            raise ValueError("Omni endpoint must be ble://<discovered-key> or serial://<port>")
        names = [name.strip().upper() for name in self.channel_names]
        if len(names) != 8 or any(not name for name in names) or len(set(names)) != 8:
            raise ValueError("Supply 8 distinct electrode names in CH1..CH8 order")
        if self.electrode_positions is not None:
            validate_electrode_positions(self.electrode_positions, 8)
        if self.electrode_names is not None:
            electrodes = [n.strip().upper() for n in self.electrode_names]
            if len(electrodes) != 8 or any(not n for n in electrodes) or len(set(electrodes)) != 8:
                raise ValueError("Supply 8 distinct electrode positions in CH1..CH8 order")
        for value in (self.max_age_sec, self.idle_timeout_sec):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Omni timeouts must be positive and finite")


class OmniWindowAssembler:
    """Retain one window. Gaps/invalid samples/restarts never get stitched together.

    Return only the newest scheduled window in a batch, so a backlog of SDK
    samples does not force inference to replay old overlapping windows.
    """

    def __init__(self, names: tuple[str, ...], window_sec: float, step_sec: float, *, electrode_names=None, electrode_positions=None):
        if not (math.isfinite(window_sec) and math.isfinite(step_sec) and 0 < step_sec <= window_sec):
            raise ValueError("Require 0 < step_sec <= window_sec")
        self.names = names
        self.electrode_names = electrode_names
        self.electrode_positions = electrode_positions
        self.size = round(window_sec * 250)
        self.hop = round(step_sec * 250)
        if self.size < 1 or self.hop < 1 or not math.isclose(step_sec * 250, self.hop):
            raise ValueError("Window/hop must be representable at 250 Hz")
        if not math.isclose(window_sec * 250, self.size):
            raise ValueError("Window must be representable at 250 Hz")
        self.rows: deque[np.ndarray] = deque(maxlen=self.size)
        self.generation: int | tuple[str, int] | None = None
        self.previous: int | None = None
        self.count = 0
        self.window_id = 0
        self.segment_id = uuid.uuid4().hex

    def reset(self) -> None:
        self.rows.clear()
        self.previous = None
        self.count = 0
        self.segment_id = uuid.uuid4().hex

    def push(self, batch) -> ParsedWindow | None:
        values = np.asarray(batch.eeg_uv)
        indices = np.asarray(batch.sample_indices)
        valid = np.asarray(batch.valid)
        if batch.sample_rate_hz != 250 or values.ndim != 2 or values.shape[1] != 8:
            raise ValueError("ESP32 SDK must provide 8 channels at 250 Hz")
        if indices.shape != (len(values),) or valid.shape != (len(values),):
            raise ValueError("SDK batch metadata length mismatch")
        if indices.dtype.kind not in "iu" or np.any(indices < 0) or valid.dtype.kind != "b":
            raise ValueError("Invalid SDK sample indices or validity mask")
        if not math.isfinite(batch.received_at):
            raise ValueError("Invalid SDK delivery timestamp")
        if batch.generation != self.generation:
            self.reset()
            self.generation = batch.generation
        latest = None
        for row, raw_index, is_valid in zip(values, indices, valid):
            index = int(raw_index)
            if self.previous is not None and index != self.previous + 1:
                self.reset()
                latest = None
            if not is_valid or not np.isfinite(row).all():
                self.reset()
                latest = None
                continue
            self.previous = index
            self.rows.append(np.array(row, dtype=np.float32, copy=True))
            self.count += 1
            if self.count >= self.size and (self.count - self.size) % self.hop == 0:
                self.window_id += 1
                latest = ParsedWindow(
                    request_id=f"omni-{self.segment_id}-{self.window_id}",
                    window_id=self.window_id, segment_id=self.segment_id,
                    sample_rate=250.0, channel_names=self.names,
                    channels=8, samples=self.size,
                    start_time_sec=(index + 1 - self.size) / 250,
                    end_time_sec=(index + 1) / 250,
                    data=np.ascontiguousarray(np.stack(self.rows).T), profile=None,
                    electrode_names=self.electrode_names, electrode_positions=self.electrode_positions,
                )
        return latest


def connect_board(config: OmniSourceConfig):
    if config.relay:
        from .omni_relay import RelayBoard
        return RelayBoard(config.endpoint)
    try:
        from omnibci import Board
    except ImportError as error:
        raise RuntimeError("Install the official omnibci 0.1.2 Windows wheel in the model Python environment") from error
    return Board.connect(config.endpoint, timeout=20)


def read_available(board):
    from omnibci import DeviceTimeoutError
    try:
        # Never read(250): that deliberately waits for a full second of samples.
        return board.read(timeout=0.1)
    except DeviceTimeoutError:
        return None


def validate_board(board) -> None:
    config = board.get_config()
    if not config.verified or config.enabled_mask != 255 or config.mode not in {"eeg", "both_bias", "no_bias"}:
        raise ValueError("Omni requires verified EEG configuration with all 8 channels enabled")
