"""Capture SDK delivery, source indices and hardware time without resampling.

This starts/stops the selected device. It MUST NOT run while the browser/relay
owns that device. --hardware is required to make that action explicit.
"""
import argparse
from dataclasses import asdict
import json
import math
from pathlib import Path
import sys
import time

import numpy as np


class IndexAudit:
    def __init__(self):
        self.rows = 0
        self.missing_positions = 0
        self.duplicates = 0
        self.backwards = 0
        self.generations = []
        self.previous_index = None
        self.previous_timestamp = None
        self.timed_position_steps = 0
        self.timed_microseconds = 0

    def note(self, batch):
        indices = np.asarray(batch.sample_indices)
        timestamps = np.asarray(batch.source_timestamp_us)
        timestamp_valid = np.asarray(batch.source_timestamp_valid)
        if any(len(a) != len(batch.eeg_uv) for a in (indices, timestamps, timestamp_valid)):
            raise ValueError("SDK metadata length differs from EEG row count")
        if not self.generations or batch.generation != self.generations[-1]:
            self.generations.append(batch.generation)
            self.previous_index = self.previous_timestamp = None
        before_missing = self.missing_positions
        for index, timestamp, valid in zip(indices, timestamps, timestamp_valid):
            index = int(index)
            timestamp = int(timestamp) if valid else None
            if self.previous_index is not None:
                delta = index - self.previous_index
                if delta > 1:
                    self.missing_positions += delta - 1
                elif delta == 0:
                    self.duplicates += 1
                elif delta < 0:
                    self.backwards += 1
                if delta > 0 and timestamp is not None and self.previous_timestamp is not None:
                    elapsed = (timestamp - self.previous_timestamp) % (2 ** 32)
                    # A >35-minute step or backwards clock is not silently unwrapped.
                    if 0 < elapsed < 2 ** 31:
                        self.timed_position_steps += delta
                        self.timed_microseconds += elapsed
            self.previous_index = index
            self.previous_timestamp = timestamp
            self.rows += 1
        return self.missing_positions - before_missing

    def summary(self):
        return {
            "delivered_rows": self.rows,
            "missing_source_positions_observed": self.missing_positions,
            "duplicate_indices": self.duplicates,
            "backwards_indices": self.backwards,
            "generations": self.generations,
            "hardware_position_rate_hz": (
                self.timed_position_steps * 1e6 / self.timed_microseconds
                if self.timed_microseconds else None
            ),
            "hardware_timed_position_steps": self.timed_position_steps,
            "hardware_timed_microseconds": self.timed_microseconds,
        }


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def capture(args):
    import omnibci

    if args.expect_revision and omnibci.SDK_REVISION != args.expect_revision:
        raise RuntimeError(f"Loaded SDK {omnibci.SDK_REVISION}, expected {args.expect_revision}; device not opened")
    args.output.mkdir(exist_ok=False)
    provenance = {
        "python": sys.executable, "package_file": omnibci.__file__,
        "python_package_version": omnibci.__version__,
        "sdk_version": omnibci.SDK_VERSION, "sdk_revision": omnibci.SDK_REVISION,
        "endpoint": args.endpoint, "device_type": args.device_type,
        "requested_seconds": args.seconds, "warmup_seconds": args.warmup_seconds,
    }
    write_json(args.output / "provenance.json", provenance)
    audit = IndexAudit()
    report = {"complete": False, "provenance": provenance}
    started = False
    board = None
    begun = None
    snapshots = []
    try:
        board = omnibci.Board.connect(args.endpoint, device_type=args.device_type, timeout=20)
        report["firmware"] = asdict(board.info) if board.info is not None else None
        report["config"] = asdict(board.get_config())
        board.start()
        started = True
        # Drain warm-up batches rather than letting a sleep accumulate stale data.
        warm_end = time.monotonic() + args.warmup_seconds
        while time.monotonic() < warm_end:
            try:
                board.read(timeout=0.1)
            except omnibci.DeviceTimeoutError:
                pass
        begun = time.monotonic()
        baseline = asdict(board.snapshot)
        snapshots.append({"seconds": 0.0, "sdk": baseline})
        next_snapshot = 1.0
        timeouts = 0
        invalid_rows = 0
        rows_by_second = {}
        with (args.output / "batches.jsonl").open("x", encoding="utf-8") as log, \
                (args.output / "eeg.f32").open("xb") as eeg, \
                (args.output / "source-indices.u64").open("xb") as indices_out, \
                (args.output / "source-time-us.u32").open("xb") as time_out, \
                (args.output / "source-time-valid.u8").open("xb") as time_valid_out, \
                (args.output / "valid.u8").open("xb") as valid_out:
            while time.monotonic() - begun < args.seconds:
                try:
                    batch = board.read(timeout=0.1)
                except omnibci.DeviceTimeoutError:
                    timeouts += 1
                    continue
                elapsed = time.monotonic() - begun
                values = np.asarray(batch.eeg_uv)
                expected_channels = 32 if args.device_type == "stm32" else 8
                if values.ndim != 2 or values.shape[1] != expected_channels:
                    raise ValueError(f"Unexpected EEG shape {values.shape}")
                if batch.sample_rate_hz != 250:
                    raise ValueError(f"Unexpected declared rate {batch.sample_rate_hz}")
                gaps = audit.note(batch)
                n = len(values)
                invalid_rows += int(np.sum(~np.asarray(batch.valid, dtype=bool)))
                second = int(elapsed)
                rows_by_second[second] = rows_by_second.get(second, 0) + n
                eeg.write(np.ascontiguousarray(values, dtype="<f4").tobytes())
                indices_out.write(np.asarray(batch.sample_indices, dtype="<u8").tobytes())
                time_out.write(np.asarray(batch.source_timestamp_us, dtype="<u4").tobytes())
                time_valid_out.write(np.asarray(batch.source_timestamp_valid, dtype="u1").tobytes())
                valid_out.write(np.asarray(batch.valid, dtype="u1").tobytes())
                log.write(json.dumps({
                    "seconds": elapsed, "rows": n, "generation": batch.generation,
                    "declared_sample_rate_hz": batch.sample_rate_hz,
                    "first_source_index": int(batch.sample_indices[0]) if n else None,
                    "last_source_index": int(batch.sample_indices[-1]) if n else None,
                    "new_missing_positions": gaps,
                    "sdk_received_at_monotonic_s": batch.received_at,
                }) + "\n")
                if elapsed >= next_snapshot:
                    snapshots.append({"seconds": elapsed, "sdk": asdict(board.snapshot)})
                    next_snapshot = math.floor(elapsed) + 1
            actual_seconds = time.monotonic() - begun
        if not audit.rows:
            raise RuntimeError("No EEG rows were received during the measurement")
        end_snapshot = asdict(board.snapshot)
        snapshots.append({"seconds": actual_seconds, "sdk": end_snapshot})
        report.update({
            **audit.summary(), "complete": True, "measurement_seconds": actual_seconds,
            "delivered_rows_per_wall_second": audit.rows / actual_seconds,
            "invalid_delivered_rows": invalid_rows, "read_timeouts": timeouts,
            "delivery_rows_by_wall_second": rows_by_second,
            "sdk_counter_deltas": {
                key: end_snapshot[key] - baseline[key]
                for key in ("samples", "missing_samples", "crc_errors")
            },
            "raw_layout": {
                "channels": expected_channels, "eeg": "little-endian float32, sample-major, uV",
                "indices": "little-endian uint64, one per EEG row",
                "source_time": "little-endian uint32 microseconds; valid mask separate",
            },
            "limitations": [
                "Direct SDK path; this does not measure browser or relay throughput.",
                "Wall-rate includes read and file-write overhead; each second is a delivery-time bucket.",
                "SDK end counters can include unread tail samples; their deltas need not equal captured rows.",
                "Hardware position rate uses index deltas, including missing positions, not just received rows.",
                "No resampling, gap filling, invalid-row removal, automatic reconnect, or configuration changes.",
            ],
        })
    except BaseException as error:
        report.update({**audit.summary(), "complete": False,
                       "error": f"{type(error).__name__}: {error}"})
        raise
    finally:
        try:
            if board is not None:
                try:
                    if started:
                        board.stop()
                finally:
                    board.close()
        except Exception as cleanup_error:
            report["cleanup_error"] = str(cleanup_error)
            report["complete"] = False
            raise
        finally:
            write_json(args.output / "sdk-snapshots.json", snapshots)
            write_json(args.output / "result.json", report)
            print(json.dumps(report, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--device-type", choices=("stm32", "esp32"), default="stm32")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--warmup-seconds", type=float, default=2)
    parser.add_argument("--expect-revision")
    parser.add_argument("--hardware", action="store_true")
    args = parser.parse_args()
    if not args.hardware:
        parser.error("--hardware required: this will start/stop acquisition; release the device first")
    if not math.isfinite(args.seconds) or not 5 <= args.seconds <= 300:
        parser.error("--seconds must be between 5 and 300")
    if not math.isfinite(args.warmup_seconds) or not 0 <= args.warmup_seconds <= 30:
        parser.error("--warmup-seconds must be between 0 and 30")
    capture(args)


if __name__ == "__main__":
    main()
