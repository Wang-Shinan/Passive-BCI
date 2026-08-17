"""CLI: train / sweep / eval / export."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import torch

from .config import TrainConfig, resolve_device
from .evaluate import evaluate_act, heuristic_baseline, random_baseline
from .export_onnx import export_checkpoint
from .run import make_learner, train, sweep
from .vec_env import SyncVectorEnv


def _cfg_from_args(args: argparse.Namespace) -> TrainConfig:
    data: dict = {}
    if args.config:
        data.update(TrainConfig.load(Path(args.config)).to_dict())
    for key in (
        "algo",
        "seed",
        "steps",
        "num_envs",
        "device",
        "precision",
        "run_dir",
        "run_name",
        "resume",
        "eval_every",
        "eval_seeds",
        "batch_size",
        "imitate_frac",
        "bc_steps",
    ):
        val = getattr(args, key.replace("-", "_"), None)
        if val is not None:
            data[key] = val
    if args.smoke:
        data.update(
            {
                "steps": 2_048,
                "num_envs": 4,
                "eval_every": 1_024,
                "eval_seeds": 4,
                "eval_max_steps": 80,
                "log_every": 512,
                "ckpt_every": 1_024,
                "batch_size": 64,
                "buffer_size": 4_096,
                "rollout_steps": 32,
                "ppo_minibatch": 64,
                "bc_batch": 64,
                "bc_steps": 1_024,
                "compute_baselines": False,
                "run_name": data.get("run_name") or f"smoke_{data.get('algo', 'dqn')}",
            }
        )
    return TrainConfig.from_dict(data)


def cmd_train(args: argparse.Namespace) -> None:
    cfg = _cfg_from_args(args)
    train(cfg)


def cmd_sweep(args: argparse.Namespace) -> None:
    sweep(Path(args.suite))


def cmd_eval(args: argparse.Namespace) -> None:
    payload = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    cfg = TrainConfig.from_dict(payload.get("config") or {})
    device = torch.device(resolve_device(args.device or cfg.device))
    dummy = SyncVectorEnv(1, 0)
    learner = make_learner(cfg, device, dummy.obs_shape)
    learner.load(payload)
    seeds = list(range(20_000, 20_000 + args.seeds))

    def act(obs: np.ndarray) -> int:
        return int(learner.act(obs[None], explore=False)[0])

    metrics = evaluate_act(act, seeds, max_steps=args.max_steps)
    summary = {
        "eval": metrics,
        "random_baseline": random_baseline(seeds[:8]),
        "heuristic_baseline": heuristic_baseline(seeds[:8], max_steps=min(400, args.max_steps)),
        "checkpoint": str(args.checkpoint),
        "step": payload.get("step") or payload.get("env_steps"),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


def cmd_export(args: argparse.Namespace) -> None:
    export_checkpoint(args.checkpoint, args.out_dir, eval_mean_lines=args.eval_mean_lines)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="tetris-rl")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_train = sub.add_parser("train", help="train one algorithm")
    p_train.add_argument("--config", type=Path, default=None)
    p_train.add_argument("--algo", choices=["dqn", "ppo", "bc", "bc_ppo"], default=None)
    p_train.add_argument("--seed", type=int, default=None)
    p_train.add_argument("--steps", type=int, default=None)
    p_train.add_argument("--num-envs", dest="num_envs", type=int, default=None)
    p_train.add_argument("--device", default=None)
    p_train.add_argument("--precision", choices=["fp32", "bf16"], default=None)
    p_train.add_argument("--run-dir", dest="run_dir", default=None)
    p_train.add_argument("--run-name", dest="run_name", default=None)
    p_train.add_argument("--resume", default=None)
    p_train.add_argument("--eval-every", dest="eval_every", type=int, default=None)
    p_train.add_argument("--eval-seeds", dest="eval_seeds", type=int, default=None)
    p_train.add_argument("--batch-size", dest="batch_size", type=int, default=None)
    p_train.add_argument("--imitate-frac", dest="imitate_frac", type=float, default=None)
    p_train.add_argument("--bc-steps", dest="bc_steps", type=int, default=None)
    p_train.add_argument("--smoke", action="store_true")
    p_train.set_defaults(func=cmd_train)

    p_sweep = sub.add_parser("sweep", help="run a suite of configs on this machine")
    p_sweep.add_argument("--suite", type=Path, required=True)
    p_sweep.set_defaults(func=cmd_sweep)

    p_eval = sub.add_parser("eval", help="evaluate a checkpoint")
    p_eval.add_argument("--checkpoint", type=Path, required=True)
    p_eval.add_argument("--seeds", type=int, default=16)
    p_eval.add_argument("--max-steps", dest="max_steps", type=int, default=800)
    p_eval.add_argument("--device", default="auto")
    p_eval.add_argument("--out", type=Path, default=Path("runs/eval_summary.json"))
    p_eval.set_defaults(func=cmd_eval)

    p_export = sub.add_parser("export", help="export ONNX for the browser")
    p_export.add_argument("--checkpoint", type=Path, required=True)
    p_export.add_argument("--out-dir", dest="out_dir", type=Path, default=Path("../public/models/tetris-rl"))
    p_export.add_argument("--eval-mean-lines", dest="eval_mean_lines", type=float, default=None)
    p_export.set_defaults(func=cmd_export)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
