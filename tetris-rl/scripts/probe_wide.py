#!/usr/bin/env python3
"""One-rollout GPU probe for the wide H20 PPO config."""

from __future__ import annotations

from pathlib import Path

import torch

from tetris_rl.config import TrainConfig
from tetris_rl.run import train


def main() -> None:
    cfg = TrainConfig.load(Path("configs/ppo_h20.json"))
    cfg.steps = 32768
    cfg.compute_baselines = False
    cfg.eval_every = 10**9
    cfg.log_every = 16384
    cfg.ckpt_every = 10**9
    cfg.run_name = "probe_ppo_wide"
    train(cfg)
    if torch.cuda.is_available():
        print("max_mem_gb", round(torch.cuda.max_memory_allocated(0) / 1e9, 2))
        print("max_reserved_gb", round(torch.cuda.max_memory_reserved(0) / 1e9, 2))


if __name__ == "__main__":
    main()
