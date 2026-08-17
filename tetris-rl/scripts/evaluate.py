#!/usr/bin/env python3
"""Evaluate trained Tetris DQN."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch

from tetris_rl.agent import DqnAgent
from tetris_rl.evaluate import evaluate, random_baseline


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=Path("checkpoints/dqn_latest.pt"))
    parser.add_argument("--seeds", type=int, default=16)
    parser.add_argument("--out", type=Path, default=Path("checkpoints/eval_summary.json"))
    args = parser.parse_args()

    device = torch.device("cpu")
    agent = DqnAgent(device=device)
    payload = torch.load(args.checkpoint, map_location=device, weights_only=False)
    agent.policy.load_state_dict(payload["policy"])
    agent.target.load_state_dict(payload["policy"])

    eval_seeds = list(range(200, 200 + args.seeds))
    metrics = evaluate(agent, eval_seeds)
    random_metrics = random_baseline(eval_seeds)
    summary = {"eval": metrics, "random_baseline": random_metrics}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
