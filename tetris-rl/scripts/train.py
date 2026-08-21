#!/usr/bin/env python3
"""Backward-compatible DQN trainer. Prefer: python -m tetris_rl train --config ..."""

from __future__ import annotations

import argparse
from pathlib import Path

from tetris_rl.config import TrainConfig
from tetris_rl.run import train


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=150_000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--eval-every", type=int, default=10_000)
    parser.add_argument("--eval-seeds", type=int, default=8)
    parser.add_argument("--out", type=Path, default=Path("runs"))
    parser.add_argument("--train-interval", type=int, default=4)
    parser.add_argument("--imitate-frac", type=float, default=0.85)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()

    cfg = TrainConfig(
        algo="dqn",
        seed=args.seed,
        steps=args.steps,
        eval_every=args.eval_every,
        eval_seeds=args.eval_seeds,
        run_dir=str(args.out),
        train_interval=args.train_interval,
        imitate_frac=args.imitate_frac,
        num_envs=8,
        dueling=True,
        double=True,
        n_step=3,
    )
    if args.smoke:
        cfg.steps = 2_048
        cfg.num_envs = 4
        cfg.eval_every = 1_024
        cfg.eval_seeds = 4
        cfg.eval_max_steps = 80
        cfg.log_every = 512
        cfg.ckpt_every = 1_024
        cfg.batch_size = 64
        cfg.buffer_size = 4_096
        cfg.compute_baselines = False
        cfg.run_name = "smoke_dqn"
    train(cfg)


if __name__ == "__main__":
    main()
