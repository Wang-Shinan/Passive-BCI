#!/usr/bin/env python3
"""Export trained DQN to ONNX + metadata for browser inference."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

import torch

from tetris_rl.encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from tetris_rl.engine import RL_ACTION_NAMES, RL_DECISION_DT_SEC
from tetris_rl.model import TetrisDQN


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=Path("checkpoints/dqn_latest.pt"))
    parser.add_argument("--out-dir", type=Path, default=Path("../public/models/tetris-rl"))
    parser.add_argument("--gravity-min", type=float, default=1.0)
    parser.add_argument("--gravity-max", type=float, default=6.0)
    parser.add_argument("--eval-mean-lines", type=float, default=None)
    args = parser.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = args.out_dir / "tetris-dqn.onnx"
    meta_path = args.out_dir / "metadata.json"

    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    model = TetrisDQN()
    model.load_state_dict(payload["policy"])
    model.eval()

    dummy = torch.zeros(1, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["observation"],
        output_names=["q_values"],
        dynamic_axes={"observation": {0: "batch"}, "q_values": {0: "batch"}},
        opset_version=17,
    )

    metadata = {
        "version": 1,
        "actionNames": RL_ACTION_NAMES,
        "decisionIntervalMs": int(RL_DECISION_DT_SEC * 1000),
        "obsChannels": RL_OBS_CHANNELS,
        "obsRows": RL_OBS_ROWS,
        "obsCols": RL_OBS_COLS,
        "gravityMin": args.gravity_min,
        "gravityMax": args.gravity_max,
        "trainedSteps": payload.get("step"),
        "evalMeanLines": args.eval_mean_lines,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Exported {onnx_path}")
    print(f"Exported {meta_path}")


if __name__ == "__main__":
    main()
