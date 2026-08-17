#!/usr/bin/env python3
"""Evaluate a checkpoint (new trainer or legacy DqnAgent)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from tetris_rl.agent import DqnAgent
from tetris_rl.config import TrainConfig, resolve_device
from tetris_rl.evaluate import evaluate, evaluate_act, heuristic_baseline, random_baseline
from tetris_rl.run import make_learner
from tetris_rl.vec_env import SyncVectorEnv


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, default=Path("runs/dqn_h20/ckpt/latest.pt"))
    parser.add_argument("--seeds", type=int, default=16)
    parser.add_argument("--out", type=Path, default=Path("runs/eval_summary.json"))
    args = parser.parse_args()

    device = torch.device(resolve_device("auto"))
    payload = torch.load(args.checkpoint, map_location=device, weights_only=False)
    eval_seeds = list(range(200, 200 + args.seeds))

    if "kind" in payload or "config" in payload:
        cfg = TrainConfig.from_dict(payload.get("config") or {})
        learner = make_learner(cfg, device, SyncVectorEnv(1, 0).obs_shape)
        learner.load(payload)

        def act(obs: np.ndarray) -> int:
            return int(learner.act(obs[None], explore=False)[0])

        metrics = evaluate_act(act, eval_seeds)
    else:
        agent = DqnAgent(device=torch.device("cpu"))
        agent.policy.load_state_dict(payload["policy"])
        metrics = evaluate(agent, eval_seeds)

    summary = {
        "eval": metrics,
        "random_baseline": random_baseline(eval_seeds[:8]),
        "heuristic_baseline": heuristic_baseline(eval_seeds[:8]),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
