"""Export a completed float32 EEG recording to BDF+ and lossless timing sidecars.

Requires numpy, pyedflib. BDF time follows stored samples, NOT elapsed wall time.
Event annotations use the latest received sample (approximate, not ERP-grade).
Original LSL/hardware/system clocks, when present, are copied without alteration.
"""
import argparse
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
import shutil
import tempfile

import numpy as np
import pyedflib


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def export(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    if output.exists():
        raise ValueError("Output already exists; choose a new directory")
    meta = read_json(source / "eeg.json")
    session = read_json(source / "session.json")
    if meta.get("status") != "complete" or session.get("status") != "complete":
        raise ValueError("Stop recording before exporting")
    if meta.get("format") != "float32-le-interleaved" or meta.get("unit") != "uV":
        raise ValueError("Only interleaved float32 microvolt recordings are supported")
    fs, channels = meta["sampleRate"], meta["channels"]
    names = meta["channelNames"]
    if not isinstance(fs, int) or fs <= 0 or channels <= 0 or len(names) != channels:
        raise ValueError("Invalid sample rate/channel metadata")
    if len(set(names)) != channels or any(not n.isascii() or not 1 <= len(n) <= 16 for n in names):
        raise ValueError("BDF requires unique ASCII channel names of at most 16 characters")
    raw_path = source / "eeg.bin"
    size = raw_path.stat().st_size
    if size == 0 or size % (4 * channels) or meta.get("bytes", size) != size:
        raise ValueError("Truncated or inconsistent EEG payload")
    samples = size // (4 * channels)
    data = np.memmap(raw_path, dtype="<f4", mode="r", shape=(samples, channels))
    if not np.isfinite(data).all():
        raise ValueError("Non-finite EEG values cannot be represented in BDF")
    end_index = meta.get("clock", {}).get("sampleIndex")
    if not isinstance(end_index, int) or end_index < samples:
        raise ValueError("Missing/inconsistent sample clock; cannot align event indices")
    origin = end_index - samples
    events = []
    event_path = source / "events.jsonl"
    if event_path.exists():
        events = [json.loads(line) for line in event_path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    annotations = [(0., -1., "TIMING_UNVERIFIED_sample_timeline")]
    mappings = []
    for row, event in enumerate(events, 1):
        clock = event.get("eeg") or (event.get("data") or {}).get("eeg") or {}
        index = clock.get("sampleIndex")
        mapping = {"eventRow": row, "method": "latest_received_sample_approximate"}
        if isinstance(index, int) and origin < index <= end_index:
            sample = index - origin - 1
            # Sidecar retains full event; short labels also survive common BDF readers.
            kind = str(event.get("type", "event")).encode("ascii", "replace").decode()[:24]
            label = f"approx/{kind}/e{row}"
            annotations.append((sample / fs, -1., label))
            mapping.update(sample=sample, onsetSeconds=sample / fs, annotation=label)
        else:
            mapping.update(method="unmapped", reason="No in-range received sample index")
        mappings.append(mapping)
    records = math.ceil(samples / fs)
    padded = records * fs - samples
    if padded:
        annotations.append((samples / fs, padded / fs, "BAD_padding"))
    annotations.sort(key=lambda item: item[0])
    annotation_channels = max(1, math.ceil(len(annotations) / records))
    if annotation_channels > 64:
        raise ValueError("Too many annotations for BDF; split the recording")
    limits = np.maximum(1, np.ceil(np.max(np.abs(data.astype(np.float64)), axis=0)))
    if any(len(str(-int(limit))) > 8 for limit in limits):
        raise ValueError("Signal exceeds supported BDF physical header range")
    started = datetime.fromisoformat(session["startedAt"].replace("Z", "+00:00"))
    if started.tzinfo is None:
        raise ValueError("Session start must include a timezone")
    headers = [dict(label=name, dimension="uV", sample_frequency=fs,
                    physical_min=-int(limit), physical_max=int(limit),
                    digital_min=-8388608, digital_max=8388607,
                    transducer="", prefilter="") for name, limit in zip(names, limits)]
    # ASCII temporary filename also supports Windows builds without Unicode paths.
    with tempfile.TemporaryDirectory(prefix="bdf_export_") as temporary:
        stage = Path(temporary)
        bdf = stage / "eeg.bdf"
        with pyedflib.EdfWriter(str(bdf), channels, file_type=pyedflib.FILETYPE_BDFPLUS) as writer:
            writer.set_number_of_annotation_signals(annotation_channels)
            writer.setSignalHeaders(headers)
            writer.setStartdatetime(started.astimezone(timezone.utc).replace(tzinfo=None))
            writer.setPatientCode(str(session.get("subjectId", "unknown")))
            writer.setRecordingAdditional("UTC sample timeline; timing unverified; see export.json")
            writer.writeSamples([np.asarray(data[:, ch], dtype=np.float64) for ch in range(channels)])
            for onset, duration, label in annotations:
                if writer.writeAnnotation(onset, duration, label) != 0:
                    raise RuntimeError("BDF annotation write failed")
        errors = []
        with pyedflib.EdfReader(str(bdf)) as reader:
            if reader.getSignalLabels() != names or not np.all(reader.getSampleFrequencies() == fs):
                raise RuntimeError("BDF channel/rate verification failed")
            if not np.all(reader.getNSamples() == records * fs):
                raise RuntimeError("BDF sample count verification failed")
            for ch, limit in enumerate(limits):
                error = float(np.max(np.abs(reader.readSignal(ch)[:samples] - data[:, ch])))
                if error > 2 * limit / 16777215 + 1e-8:
                    raise RuntimeError("BDF quantization exceeded one digital step")
                errors.append(error)
            onset, duration, labels = reader.readAnnotations()
            if list(labels) != [a[2] for a in annotations] or not np.allclose(onset, [a[0] for a in annotations], atol=0.000051, rtol=0):
                raise RuntimeError("BDF annotations lost or changed during export")
        sidecars = stage / "original"
        sidecars.mkdir()
        for name in ("session.json", "eeg.json", "eeg.idx.json", "events.jsonl", "context.jsonl"):
            path = source / name
            if path.exists():
                shutil.copy2(path, sidecars / name)
        linked = []
        for folder in sorted(source.parent.glob("nback_*")):
            behavior_path = folder / "behavior.json"
            if not behavior_path.is_file():
                continue
            behavior = read_json(behavior_path)
            rel = behavior.get("eegSessionRel", "")
            if str(rel).replace("\\", "/").rstrip("/").split("/")[-1] != source.name:
                continue
            target = sidecars / folder.name
            target.mkdir()
            for name in ("behavior.json", "session.json", "events.jsonl"):
                if (folder / name).is_file():
                    shutil.copy2(folder / name, target / name)
            linked.append(folder.name)
        (stage / "event_mapping.json").write_text(json.dumps(mappings, indent=2), encoding="utf-8")
        report = dict(format="BDF+", source=str(source), sampleRate=fs, channels=names,
                      originalSamples=samples, durationSeconds=samples / fs, paddingSamples=padded,
                      sampleIndexOrigin=origin, annotations=len(annotations), linkedBehavior=linked,
                      maxRoundtripErrorUv=errors, headerTimezone="UTC",
                      warnings=["Sample timeline concatenates stored samples; gaps are not reconstructed.",
                                "Event positions are latest-received-sample approximations, NOT ERP-grade synchronization.",
                                "Header start is recording start, not verified ADC sample-zero time.",
                                "Original clocks, including null/missing values, are preserved in sidecars.",
                                "BAD_padding marks synthetic samples at the end; exclude them from analysis."],
                      sourceEegSha256=hashlib.file_digest(raw_path.open("rb"), "sha256").hexdigest(),
                      files={p.relative_to(stage).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                             for p in stage.rglob("*") if p.is_file()})
        (stage / "export.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(stage, output)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("output", type=Path, help="New export directory (must not already exist)")
    args = parser.parse_args()
    print(json.dumps(export(args.session, args.output), ensure_ascii=False, indent=2))
