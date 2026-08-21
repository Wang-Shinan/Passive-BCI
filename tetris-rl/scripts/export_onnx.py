#!/usr/bin/env python3
"""Export a checkpoint to ONNX for the browser."""

from __future__ import annotations

import argparse
from pathlib import Path

from tetris_rl.export_onnx import export_checkpoint


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=Path("runs/dqn_h20/ckpt/latest.pt"))
    parser.add_argument("--out-dir", type=Path, default=Path("../public/models/tetris-rl"))
    parser.add_argument("--eval-mean-lines", type=float, default=None)
    args = parser.parse_args()
    export_checkpoint(args.checkpoint, args.out_dir, eval_mean_lines=args.eval_mean_lines)


if __name__ == "__main__":
    main()
