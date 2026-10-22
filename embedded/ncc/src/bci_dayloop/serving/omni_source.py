"""Omni SDK batches -> continuous model windows, without browser transport."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import math
import uuid

import numpy as np

from .protocol import ParsedWindow, validate_electrode_positions


def channel_count(device_type: str) -> int:
    if device_type not in ("esp32", "stm32"):
        raise ValueError("Omni device_type must be esp32 or stm32")
    return 32 if device_type == "stm32" else 8


def sdk_device_options(device_type: str) -> dict:
    channel_count(device_type)
    if device_type == "esp32":
        return {}  # Keep compatibility with the released 0.1.2 binding.
    import omnibci
    if not hasattr(omnibci, "Stm32Config"):
        raise RuntimeError("STM32 32 通道需要 omnibci 0.2.0 的 32ch 构建；当前环境仅支持 ESP32 8 通道")
    return {"device_type": device_type}


def open_sdk_board(endpoint: str, device_type: str = "esp32"):
    from omnibci import Board
    return Board.connect(endpoint, timeout=20, **sdk_device_options(device_type))


@dataclass(frozen=True)
class OmniSourceConfig:
    endpoint: str
    channel_names: tuple[str, ...]
    max_age_sec: float = 1.0
    idle_timeout_sec: float = 5.0
    relay: bool = False
    electrode_names: tuple[str, ...] | None = None
    electrode_positions: tuple[tuple[float, float, float], ...] | None = None
    device_type: str = "esp32"

    @property
    def channels(self) -> int:
        return channel_count(self.device_type)

    def __post_init__(self) -> None:
        if not self.endpoint.startswith(("ble://", "serial://")) or not self.endpoint.split("://", 1)[1]:
            raise ValueError("Omni endpoint must be ble://<discovered-key> or serial://<port>")
        names = [name.strip().upper() for name in self.channel_names]
        if len(names) != self.channels or any(not name for name in names) or len(set(names)) != self.channels:
            raise ValueError(f"Supply {self.channels} distinct channel names in hardware order")
        if self.electrode_positions is not None:
            validate_electrode_positions(self.electrode_positions, self.channels)
        if self.electrode_names is not None:
            electrodes = [n.strip().upper() for n in self.electrode_names]
            if len(electrodes) != self.channels or any(not n for n in electrodes) or len(set(electrodes)) != self.channels:
                raise ValueError(f"Supply {self.channels} distinct electrode positions in hardware order")
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
        if len(names) not in (8, 32):
            raise ValueError("Omni windows require 8 or 32 channels")
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
        if batch.sample_rate_hz != 250 or values.ndim != 2 or values.shape[1] != len(self.names):
            raise ValueError(f"Omni SDK must provide {len(self.names)} channels at 250 Hz")
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
                    channels=len(self.names), samples=self.size,
                    start_time_sec=(index + 1 - self.size) / 250,
                    end_time_sec=(index + 1) / 250,
                    data=np.ascontiguousarray(np.stack(self.rows).T), profile=None,
                    electrode_names=self.electrode_names, electrode_positions=self.electrode_positions,
                )
        return latest


def connect_board(config: OmniSourceConfig):
    if config.relay:
        from .omni_relay import RelayBoard
        return RelayBoard(config.endpoint, device_type=config.device_type)
    try:
        return open_sdk_board(config.endpoint, config.device_type)
    except ImportError as error:
        raise RuntimeError("Install the official omnibci Windows wheel in the model Python environment") from error


def read_available(board):
    from omnibci import DeviceTimeoutError
    try:
        # Never read(250): that deliberately waits for a full second of samples.
        return board.read(timeout=0.1)
    except DeviceTimeoutError:
        return None


def validate_board(board, channels: int = 8) -> None:
    config = board.get_config()
    if not config.verified or config.enabled_mask != (1 << channels) - 1 or config.mode not in {"eeg", "both_bias", "no_bias"}:
        raise ValueError(f"Omni requires verified EEG configuration with all {channels} channels enabled")
    if getattr(config, "loff_mask", 0):
        raise ValueError("Disable STM32 lead-off excitation before model inference")
