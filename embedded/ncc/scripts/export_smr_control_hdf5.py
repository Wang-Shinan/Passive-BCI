from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
from pathlib import Path
import shutil
import sys

from _bootstrap import ROOT  # noqa: F401
from bci_dayloop.data.hdf5_dataset import EEGHDF5
from bci_dayloop.serving.smr_sessions import (
    LABEL_SOURCES,
    SMR_CONTROL_CLASS_NAMES,
    discover_smr_recordings,
    extract_all_labeled_windows,
    windows_to_hdf5,
)


def default_recordings_root() -> Path:
    sibling = ROOT.parents[1] / "recordings"
    if sibling.is_dir():
        return sibling
    return Path.cwd() / "recordings"


def resolve_sessions(root: Path, sessions: list[str] | None) -> list[Path]:
    if not sessions:
        return discover_smr_recordings(root)
    resolved: list[Path] = []
    for item in sessions:
        path = Path(item)
        if not path.is_absolute():
            path = root / item
        path = path.resolve()
        if not path.is_dir():
            raise SystemExit(f"Missing session: {item}")
        resolved.append(path)
    return resolved


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export Passive-BCI SMR bins as NCC EEGHDF5 (2s non-overlapping windows, uV, CT)."
    )
    parser.add_argument("--recordings", type=Path, default=default_recordings_root())
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "data" / "processed" / "smr_control" / "subject_01.h5",
    )
    parser.add_argument("--backup", type=Path, default=None)
    parser.add_argument("--no-backup", action="store_true")
    parser.add_argument("--sessions", nargs="+", default=None)
    parser.add_argument("--label-source", choices=LABEL_SOURCES, default="auto")
    parser.add_argument("--subject-id", type=int, default=1)
    parser.add_argument("--keep-padded", action="store_true")
    parser.add_argument("--window-sec", type=float, default=2.0)
    parser.add_argument(
        "--hop-sec",
        type=float,
        default=None,
        help=(
            "Offline slice hop. Default equals --window-sec (non-overlapping). "
            "Do not pass the live Tetris 0.1s hop here."
        ),
    )
    args = parser.parse_args()

    recordings_root = args.recordings.resolve()
    recordings = resolve_sessions(recordings_root, args.sessions)
    windows = extract_all_labeled_windows(
        recordings,
        window_sec=args.window_sec,
        label_source=args.label_source,
        hop_sec=args.hop_sec,
    )
    if not windows:
        raise SystemExit(f"No labeled SMR trials in {args.recordings}")

    output = args.output.resolve()
    path = windows_to_hdf5(
        windows,
        output,
        subject_id=args.subject_id,
        drop_padded=not args.keep_padded,
    )
    dataset = EEGHDF5(path)
    loaded = dataset.load()
    counts = Counter(int(label) for label in loaded["labels"])
    named = {SMR_CONTROL_CLASS_NAMES[index]: counts[index] for index in range(len(SMR_CONTROL_CLASS_NAMES))}
    hop_sec = args.window_sec if args.hop_sec is None else args.hop_sec
    print(
        f"[export-smr] {path} trials={loaded['data'].shape[0]} "
        f"shape={tuple(loaded['data'].shape)} Hz={dataset.metadata.sample_rate:g} "
        f"unit={dataset.metadata.unit} classes={named} "
        f"window={args.window_sec:g}s hop={hop_sec:g}s "
        f"sessions={dataset.sessions()}"
    )

    if args.no_backup:
        return
    backup = args.backup
    if backup is None:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = recordings_root / ".reve-heads" / f"smr_control_s{args.subject_id:02d}_{stamp}.h5"
    backup = backup.resolve()
    if backup == path:
        return
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    print(f"[export-smr] backup {backup}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
