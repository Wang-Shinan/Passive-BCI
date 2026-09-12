# OmniBCI Local API and Python SDK

## Scope

The SDK connects only to the OmniBCI application running on the same Windows
computer. It exposes processed EEG samples and application-level controls. It
does not expose product implementation details.

Default endpoint:

```text
ws://127.0.0.1:8765/v1/stream
```

The control endpoint is `ws://127.0.0.1:8765/v1/control`. Both endpoints are
localhost-only.

## Install

Open PowerShell in this `sdk` directory:

```powershell
py -3 -m pip install -r requirements.txt
```

Keep `omnibci_sdk.py` beside your script, or add this directory to
`PYTHONPATH`.

## Read EEG

```python
from omnibci_sdk import GapEvent, MarkerEvent, connect_local

client = connect_local()
with client.stream_raw() as stream:
    for item in stream:
        if isinstance(item, GapEvent):
            print("gap", item.dropped_samples)
            continue
        if isinstance(item, MarkerEvent):
            print("marker", item.code, item.value)
            continue

        # item.values: float32, shape (samples, 8), unit uV
        # item.sequence: uint32 sequence for every sample
        # item.valid: bool validity flag for every sample
        eeg_uv = item.values
        print(eeg_uv.shape, item.sequence[0], item.valid.all())
```

Use `stream_filtered()` instead of `stream_raw()` to receive the application's
current filtered output.

## Send Trigger

Trigger numbers are integers from 1 to 255. A measurement must already be
running.

```python
from omnibci_sdk import connect_local

client = connect_local()
event = client.send_trigger(23)
print(event.event_id, event.sequence)
```

When the exact sample sequence is known:

```python
client.send_trigger(23, sequence=12500)
```

For richer annotations, use `send_marker`:

```python
client.send_marker(
    code="stimulus_on",
    value=1,
    sequence=12500,
    description="visual stimulus",
)
```

## Stop and Export

```python
client.stop_measurement()
result = client.export_bdf(r"C:\Data\session_001.bdf")
print(result.path, result.event_count, result.sample_count)
```

The destination must be a writable local path. Existing files are rejected by
default. Pass `overwrite=True` only when replacement is intentional.

## Data Contract

| Field | Type | Description |
| --- | --- | --- |
| `values` | `float32[samples, 8]` | EEG values in `uV` |
| `sequence` | `uint32[samples]` | Sample sequence |
| `valid` | `bool[samples]` | Whether each sample is valid |
| `modes` | `uint8[samples]` | Application acquisition mode code |
| `stream` | `str` | `raw` or `filtered` |
| `generation` | `int | None` | Filter configuration generation |
| `sample_rate` | `int` | `250` |
| `channels` | `tuple[str, ...]` | `CH1` through `CH8` |
| `unit` | `str` | `uV` |

`GapEvent` means the client did not consume the real-time stream fast enough.
Discard the current analysis window and begin with fresh continuous samples.
Do not replace invalid samples with fabricated EEG data.

## Raw WebSocket API

Python users should use the SDK above. Other languages can implement the same
WebSocket contract.

After connecting to `/v1/stream`, send one subscription message:

```json
{"type":"subscribe","stream":"raw"}
```

Use `filtered` instead of `raw` for the application's filtered output. The
server first returns a JSON `hello` message. Each EEG batch is then sent as two
consecutive WebSocket messages:

1. A JSON header with `type=data`, metadata arrays, `shape`, and `dtype=float32`.
2. A binary payload containing little-endian float32 values in
   `(samples, channels)` row-major order.

Marker and gap events are standalone JSON messages and have no following binary
payload.

Control operations use a new connection to `/v1/control`. Every request must
contain a unique `request_id`. The response returns the same ID:

```json
{
  "type": "control_response",
  "schema_version": 1,
  "request_id": "your-unique-id",
  "ok": true,
  "result": {}
}
```

Send a marker or Trigger:

```json
{
  "type": "marker",
  "request_id": "your-unique-id",
  "code": "soft_trigger",
  "value": 23,
  "sequence": null,
  "duration": 0.0,
  "description": ""
}
```

Stop the current measurement:

```json
{"type":"stop_measurement","request_id":"your-unique-id"}
```

Export the completed measurement:

```json
{
  "type": "export_bdf",
  "request_id": "your-unique-id",
  "path": "C:\\Data\\session_001.bdf",
  "overwrite": false
}
```

When `ok` is false, the response contains an `error` object with a stable
machine-readable `code` and a human-readable `message`.

## Error Handling

All protocol and connection failures are raised as `ProtocolError`. A refused
connection usually means the application is not running. An idle stream means
that measurement has not started yet.
