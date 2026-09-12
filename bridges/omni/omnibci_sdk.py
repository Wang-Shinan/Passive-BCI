"""Public synchronous Python SDK for the local OmniBCI EEG API."""

from __future__ import annotations

from dataclasses import dataclass
import inspect
import json
import math
import os
from typing import Any, Iterator
from urllib.parse import urlsplit, urlunsplit
import uuid

import numpy as np
from websockets.exceptions import ConnectionClosedOK


SCHEMA_VERSION = 1
SAMPLE_RATE = 250
CHANNELS = tuple(f"CH{i}" for i in range(1, 9))
STREAM_PATH = "/v1/stream"
CONTROL_PATH = "/v1/control"
STREAM_RAW = "raw"
STREAM_FILTERED = "filtered"
_FLOAT32_LE = np.dtype("<f4")


class ProtocolError(RuntimeError):
    """Raised when the local API returns an invalid response."""


@dataclass(frozen=True)
class GapEvent:
    stream: str
    dropped_batches: int
    dropped_samples: int
    dropped_markers: int = 0


@dataclass(frozen=True)
class MarkerEvent:
    event_id: str
    session_id: str
    recording_id: str
    code: str
    value: None | bool | int | float | str
    timestamp: float
    sequence: int | None
    duration: float
    description: str = ""

    @classmethod
    def from_dict(cls, value: Any) -> "MarkerEvent":
        if not isinstance(value, dict) or value.get("type") != "marker":
            raise ValueError("marker event must have type=marker")
        if value.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("unsupported marker schema version")
        required = (
            "event_id", "session_id", "recording_id", "code", "value",
            "timestamp", "sequence", "duration", "description",
        )
        if any(key not in value for key in required):
            raise ValueError("marker event is missing a required field")
        if not all(isinstance(value[key], str) and value[key] for key in (
            "event_id", "session_id", "recording_id", "code",
        )):
            raise ValueError("marker identifiers must be non-empty strings")
        marker_value = value["value"]
        if not isinstance(marker_value, (type(None), bool, int, float, str)):
            raise ValueError("marker value must be a JSON scalar")
        timestamp = value["timestamp"]
        duration = value["duration"]
        sequence = value["sequence"]
        if (
            not isinstance(timestamp, (int, float))
            or isinstance(timestamp, bool)
            or not math.isfinite(float(timestamp))
        ):
            raise ValueError("marker timestamp must be finite")
        if (
            not isinstance(duration, (int, float))
            or isinstance(duration, bool)
            or not math.isfinite(float(duration))
            or duration < 0
        ):
            raise ValueError("marker duration must be non-negative")
        if sequence is not None and (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or not 0 <= sequence <= 0xFFFFFFFF
        ):
            raise ValueError("marker sequence must be uint32 or None")
        return cls(
            event_id=value["event_id"],
            session_id=value["session_id"],
            recording_id=value["recording_id"],
            code=value["code"],
            value=marker_value,
            timestamp=float(timestamp),
            sequence=sequence,
            duration=float(duration),
            description=value["description"],
        )


@dataclass(frozen=True)
class StreamBatch:
    stream: str
    values: np.ndarray
    sequence: np.ndarray
    valid: np.ndarray
    modes: np.ndarray
    generation: int | None
    session_id: str
    sample_rate: int
    channels: tuple[str, ...]
    unit: str

    @classmethod
    def from_messages(cls, header: str, payload: bytes) -> "StreamBatch":
        try:
            metadata = json.loads(header)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ValueError("invalid data header JSON") from exc
        if not isinstance(metadata, dict) or metadata.get("type") != "data":
            raise ValueError("data header must have type=data")
        if metadata.get("schema_version") != SCHEMA_VERSION:
            raise ValueError("unsupported stream schema version")
        if metadata.get("dtype") != "float32":
            raise ValueError("unsupported stream data type")
        shape = metadata.get("shape")
        if (
            not isinstance(shape, list)
            or len(shape) != 2
            or not all(isinstance(item, int) and not isinstance(item, bool) and item >= 0 for item in shape)
        ):
            raise ValueError("invalid data shape")
        channels = metadata.get("channels")
        if not isinstance(channels, list) or not channels or not all(isinstance(item, str) and item for item in channels):
            raise ValueError("invalid channel list")
        expected_bytes = shape[0] * shape[1] * _FLOAT32_LE.itemsize
        if not isinstance(payload, bytes) or len(payload) != expected_bytes:
            raise ValueError("binary payload length does not match data shape")
        values = np.frombuffer(payload, dtype=_FLOAT32_LE).reshape(shape).copy()
        sequence = np.asarray(metadata.get("sequence"))
        valid = np.asarray(metadata.get("valid"))
        modes = np.asarray(metadata.get("modes"))
        if sequence.ndim != 1 or sequence.size != shape[0] or not np.issubdtype(sequence.dtype, np.integer):
            raise ValueError("invalid sequence array")
        if valid.ndim != 1 or valid.size != shape[0] or valid.dtype != np.dtype(bool):
            raise ValueError("invalid valid array")
        if modes.ndim != 1 or modes.size != shape[0] or not np.issubdtype(modes.dtype, np.integer):
            raise ValueError("invalid modes array")
        if np.any(sequence < 0) or np.any(sequence > 0xFFFFFFFF) or np.any(modes < 0) or np.any(modes > 0xFF):
            raise ValueError("stream metadata contains an out-of-range value")
        return cls(
            stream=metadata.get("stream"),
            values=values,
            sequence=sequence.astype("<u4", copy=True),
            valid=valid.astype(bool, copy=True),
            modes=modes.astype("u1", copy=True),
            generation=metadata.get("generation"),
            session_id=metadata.get("session_id"),
            sample_rate=metadata.get("sample_rate"),
            channels=tuple(channels),
            unit=metadata.get("unit"),
        )


@dataclass(frozen=True)
class ExportResult:
    path: str
    recording_id: str
    event_count: int
    sample_count: int


@dataclass
class _StreamIterator:
    stream: str
    connection: Any

    def __iter__(self) -> "_StreamIterator":
        return self

    def __next__(self) -> StreamBatch | GapEvent | MarkerEvent:
        try:
            message = self.connection.recv()
        except ConnectionClosedOK:
            self.close()
            raise StopIteration
        if not isinstance(message, str):
            self.close()
            raise ProtocolError("expected a JSON event")
        try:
            event = json.loads(message)
        except json.JSONDecodeError as exc:
            self.close()
            raise ProtocolError("API sent invalid JSON") from exc
        if not isinstance(event, dict):
            self.close()
            raise ProtocolError("API event must be an object")
        if event.get("type") == "gap":
            if event.get("stream") != self.stream:
                self.close()
                raise ProtocolError("gap stream does not match subscription")
            return GapEvent(
                stream=self.stream,
                dropped_batches=int(event.get("dropped_batches", 0)),
                dropped_samples=int(event.get("dropped_samples", 0)),
                dropped_markers=int(event.get("dropped_markers", 0)),
            )
        if event.get("type") == "marker":
            try:
                return MarkerEvent.from_dict(event)
            except (TypeError, ValueError, KeyError) as exc:
                self.close()
                raise ProtocolError("API sent an invalid marker") from exc
        if event.get("type") != "data" or event.get("stream") != self.stream:
            self.close()
            raise ProtocolError("unexpected API event")
        payload = self.connection.recv()
        if not isinstance(payload, bytes):
            self.close()
            raise ProtocolError("data header was not followed by binary data")
        try:
            return StreamBatch.from_messages(message, payload)
        except (TypeError, ValueError, KeyError) as exc:
            self.close()
            raise ProtocolError("API sent invalid stream data") from exc

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    def __enter__(self) -> "_StreamIterator":
        return self

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.close()


class LocalClient:
    def __init__(self, url: str = "ws://127.0.0.1:8765/v1/stream", timeout: float = 5.0):
        parsed = urlsplit(url)
        if parsed.path != STREAM_PATH:
            raise ValueError(f"stream URL must end with {STREAM_PATH}")
        self.url = url
        self.timeout = float(timeout)
        self.control_url = urlunsplit((parsed.scheme, parsed.netloc, CONTROL_PATH, parsed.query, parsed.fragment))
        self.hello: dict[str, Any] | None = None

    def stream_raw(self) -> Iterator[StreamBatch | GapEvent | MarkerEvent]:
        return self._open_stream(STREAM_RAW)

    def stream_filtered(self) -> Iterator[StreamBatch | GapEvent | MarkerEvent]:
        return self._open_stream(STREAM_FILTERED)

    def send_trigger(self, number: int, *, sequence: int | None = None) -> MarkerEvent:
        if not isinstance(number, int) or isinstance(number, bool) or not 1 <= number <= 255:
            raise ValueError("trigger number must be between 1 and 255")
        return self.send_marker("soft_trigger", number, sequence=sequence)

    def send_marker(
        self,
        code: str,
        value: None | bool | int | float | str = None,
        *,
        timestamp: float | None = None,
        sequence: int | None = None,
        duration: float = 0.0,
        description: str = "",
    ) -> MarkerEvent:
        request: dict[str, Any] = {
            "type": "marker", "code": code, "value": value,
            "sequence": sequence, "duration": duration, "description": description,
        }
        if timestamp is not None:
            request["timestamp"] = timestamp
        try:
            return MarkerEvent.from_dict(self._control_request(request))
        except (TypeError, ValueError, KeyError) as exc:
            raise ProtocolError("API returned an invalid marker result") from exc

    def stop_measurement(self) -> dict[str, Any]:
        return self._control_request({"type": "stop_measurement"})

    def export_bdf(self, path: os.PathLike[str] | str, *, overwrite: bool = False) -> ExportResult:
        if not isinstance(overwrite, bool):
            raise TypeError("overwrite must be a bool")
        result = self._control_request({"type": "export_bdf", "path": os.fspath(path), "overwrite": overwrite})
        try:
            return ExportResult(
                path=result["path"], recording_id=result["recording_id"],
                event_count=int(result["event_count"]), sample_count=int(result["sample_count"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ProtocolError("API returned an invalid export result") from exc

    def _control_request(self, request: dict[str, Any]) -> dict[str, Any]:
        from websockets.sync.client import connect

        request_id = uuid.uuid4().hex
        request = {**request, "request_id": request_id}
        try:
            with connect(self.control_url, **self._connect_options(connect)) as connection:
                connection.send(json.dumps(request, ensure_ascii=False, separators=(",", ":")))
                message = connection.recv()
        except Exception as exc:
            raise ProtocolError("could not complete API control request") from exc
        try:
            response = json.loads(message)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ProtocolError("API sent invalid control JSON") from exc
        if (
            not isinstance(response, dict)
            or response.get("type") != "control_response"
            or response.get("schema_version") != SCHEMA_VERSION
            or response.get("request_id") != request_id
        ):
            raise ProtocolError("API sent an invalid control response")
        if not response.get("ok"):
            error = response.get("error", {})
            raise ProtocolError(f"API control error {error.get('code', 'unknown')}: {error.get('message', 'failed')}")
        result = response.get("result", {})
        if not isinstance(result, dict):
            raise ProtocolError("API control result must be an object")
        return result

    def _open_stream(self, stream: str) -> _StreamIterator:
        from websockets.sync.client import connect

        connection = connect(self.url, **self._connect_options(connect))
        try:
            connection.send(json.dumps({"type": "subscribe", "stream": stream}, separators=(",", ":")))
            hello = json.loads(connection.recv())
            if (
                not isinstance(hello, dict)
                or hello.get("type") != "hello"
                or hello.get("schema_version") != SCHEMA_VERSION
                or hello.get("stream") != stream
                or hello.get("sample_rate") != SAMPLE_RATE
                or hello.get("channels") != list(CHANNELS)
                or hello.get("unit") != "uV"
            ):
                raise ProtocolError("API hello is incompatible with this SDK")
            self.hello = hello
            return _StreamIterator(stream, connection)
        except BaseException:
            connection.close()
            raise

    def _connect_options(self, connect) -> dict[str, Any]:
        options: dict[str, Any] = {
            "open_timeout": self.timeout, "close_timeout": self.timeout, "max_size": None,
        }
        if "proxy" in inspect.signature(connect).parameters:
            options["proxy"] = None
        return options


def connect_local(port: int = 8765, timeout: float = 5.0) -> LocalClient:
    if not isinstance(port, int) or isinstance(port, bool) or not 0 <= port <= 65535:
        raise ValueError("port must be between 0 and 65535")
    return LocalClient(f"ws://127.0.0.1:{port}/v1/stream", timeout=timeout)


__all__ = [
    "ExportResult", "GapEvent", "LocalClient", "MarkerEvent",
    "ProtocolError", "StreamBatch", "connect_local",
]
