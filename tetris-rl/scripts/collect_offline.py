#!/usr/bin/env python3
"""Collect offline data from a line-clearing teacher (placement beam BFS).

Stop when the dataset has enough successful play, not after a fixed episode
count. Depth only exists so the teacher actually clears; the guarantee is
coverage: cleared episodes, total lines, and clear-event transitions.
"""

from __future__ import annotations

import argparse
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from tetris_rl.encode import RL_OBS_CHANNELS
from tetris_rl.engine import RL_ACTION_NAMES
from tetris_rl.env import TetrisEnv
from tetris_rl.heuristic import HeuristicPlanner
from tetris_rl.search import DEFAULT_BEAM, DEFAULT_DEPTH, DEFAULT_MAX_NODES


def play_episode(env: TetrisEnv, planner: HeuristicPlanner, seed: int, max_steps: int):
    obs, _ = env.reset(seed=seed)
    frames: list[np.ndarray] = []
    next_frames: list[np.ndarray] = []
    actions: list[int] = []
    rewards: list[float] = []
    dones: list[bool] = []
    line_deltas: list[int] = []
    info = {"lines": 0, "score": 0}
    prev_lines = 0
    for _ in range(max_steps):
        action = planner.act(env.state, env._rng_fn)
        frames.append(obs)
        actions.append(int(action))
        obs, reward, terminated, truncated, info = env.step(action)
        done = bool(terminated or truncated)
        nxt_lines = int(info["lines"])
        line_deltas.append(nxt_lines - prev_lines)
        prev_lines = nxt_lines
        next_frames.append(obs)
        rewards.append(float(reward))
        dones.append(done)
        if done:
            break
    return {
        "obs": np.stack(frames, axis=0).astype(np.float16),
        "next_obs": np.stack(next_frames, axis=0).astype(np.float16),
        "actions": np.asarray(actions, dtype=np.int64),
        "rewards": np.asarray(rewards, dtype=np.float32),
        "dones": np.asarray(dones, dtype=np.bool_),
        "line_deltas": np.asarray(line_deltas, dtype=np.int16),
        "lines": int(info["lines"]),
        "score": int(info["score"]),
    }


def _play_one(payload: dict) -> dict:
    env = TetrisEnv()
    planner = HeuristicPlanner(
        depth=payload["depth"],
        beam=payload["beam"],
        max_nodes=payload["max_nodes"],
        workers=0,
        mc_samples=payload["mc_samples"],
        mc_horizon=payload["mc_horizon"],
        device=payload["device"],
    )
    try:
        return play_episode(env, planner, payload["seed"], payload["max_steps"])
    finally:
        planner.close()


def _coverage(chunks: list[dict]) -> dict[str, float | int]:
    lines = [int(c["lines"]) for c in chunks]
    deltas = [c["line_deltas"] for c in chunks]
    return {
        "episodes": len(chunks),
        "cleared_episodes": int(sum(1 for x in lines if x > 0)),
        "total_lines": int(sum(lines)),
        "mean_lines": float(np.mean(lines)) if lines else 0.0,
        "clear_events": int(sum(int((d > 0).sum()) for d in deltas)),
        "transitions": int(sum(len(c["actions"]) for c in chunks)),
    }


def _met(cov: dict[str, float | int], args: argparse.Namespace) -> bool:
    return (
        int(cov["episodes"]) >= args.min_episodes
        and int(cov["cleared_episodes"]) >= args.min_cleared
        and int(cov["total_lines"]) >= args.min_lines
        and int(cov["clear_events"]) >= args.min_clear_events
        and int(cov["transitions"]) >= args.min_transitions
    )


def _save(out: Path, chunks: list[dict], extra: dict) -> dict:
    payload = {
        "obs": np.concatenate([c["obs"] for c in chunks], axis=0),
        "next_obs": np.concatenate([c["next_obs"] for c in chunks], axis=0),
        "actions": np.concatenate([c["actions"] for c in chunks], axis=0),
        "rewards": np.concatenate([c["rewards"] for c in chunks], axis=0),
        "dones": np.concatenate([c["dones"] for c in chunks], axis=0),
        "line_deltas": np.concatenate([c["line_deltas"] for c in chunks], axis=0),
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, **payload)
    summary = {
        "out": str(out),
        "obs_channels": RL_OBS_CHANNELS,
        "action_names": RL_ACTION_NAMES,
        "mean_score": float(np.mean([c["score"] for c in chunks])),
        "lines": [int(c["lines"]) for c in chunks],
        **extra,
        **_coverage(chunks),
    }
    out.with_suffix(".json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    return summary


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--max-episodes", dest="max_episodes", type=int, default=2048)
    p.add_argument("--min-episodes", dest="min_episodes", type=int, default=64)
    p.add_argument("--min-cleared", dest="min_cleared", type=int, default=64)
    p.add_argument("--min-lines", dest="min_lines", type=int, default=2048)
    p.add_argument("--min-clear-events", dest="min_clear_events", type=int, default=512)
    p.add_argument("--min-transitions", dest="min_transitions", type=int, default=50_000)
    p.add_argument("--batch-size", dest="batch_size", type=int, default=0)
    p.add_argument("--max-steps", dest="max_steps", type=int, default=800)
    p.add_argument("--seed", type=int, default=10_000)
    p.add_argument("--depth", type=int, default=DEFAULT_DEPTH)
    p.add_argument("--beam", type=int, default=DEFAULT_BEAM)
    p.add_argument("--max-nodes", dest="max_nodes", type=int, default=DEFAULT_MAX_NODES)
    p.add_argument("--mc-samples", dest="mc_samples", type=int, default=0)
    p.add_argument("--mc-horizon", dest="mc_horizon", type=int, default=3)
    p.add_argument("--workers", type=int, default=-1)
    p.add_argument(
        "--device",
        default="auto",
        help="auto|cuda|cpu|none — cuda batches lock+score; none = Python",
    )
    p.add_argument("--out", type=Path, default=Path("runs/offline/lookahead.npz"))
    args = p.parse_args()

    workers = os.cpu_count() or 1 if args.workers < 0 else max(1, args.workers)
    use_cuda = args.device == "cuda"
    if args.device == "auto":
        try:
            import torch

            use_cuda = torch.cuda.is_available()
        except Exception:
            use_cuda = False
    if use_cuda and workers > 1:
        workers = 1
    batch = args.batch_size if args.batch_size > 0 else max(1, workers)
    chunks: list[dict] = []
    next_seed = args.seed
    template = {
        "max_steps": args.max_steps,
        "depth": args.depth,
        "beam": args.beam,
        "max_nodes": args.max_nodes,
        "mc_samples": args.mc_samples,
        "mc_horizon": args.mc_horizon,
        "device": args.device,
    }

    print(
        f"[collect] teacher depth={args.depth} beam={args.beam} device={args.device} "
        f"workers={workers} "
        f"until min_cleared={args.min_cleared} min_lines={args.min_lines} "
        f"min_clear_events={args.min_clear_events} min_transitions={args.min_transitions} "
        f"min_episodes={args.min_episodes} max_episodes={args.max_episodes}",
        flush=True,
    )

    while len(chunks) < args.max_episodes:
        n = min(batch, args.max_episodes - len(chunks))
        jobs = [{**template, "seed": next_seed + i} for i in range(n)]
        next_seed += n
        if workers == 1 or n == 1:
            batch_eps = [_play_one(job) for job in jobs]
        else:
            with ProcessPoolExecutor(max_workers=min(workers, n)) as pool:
                batch_eps = list(pool.map(_play_one, jobs))
        chunks.extend(batch_eps)
        cov = _coverage(chunks)
        print(
            f"[collect] episodes={cov['episodes']} cleared={cov['cleared_episodes']} "
            f"total_lines={cov['total_lines']} clear_events={cov['clear_events']} "
            f"transitions={cov['transitions']} mean_lines={cov['mean_lines']:.2f}",
            flush=True,
        )
        _save(
            args.out,
            chunks,
            {
                "depth": args.depth,
                "beam": args.beam,
                "max_nodes": args.max_nodes,
                "mc_samples": args.mc_samples,
                "mc_horizon": args.mc_horizon,
                "workers": workers,
            },
        )
        if _met(cov, args):
            break

    summary = json.loads(args.out.with_suffix(".json").read_text(encoding="utf-8"))
    if not _met(_coverage(chunks), args):
        print("[collect] hit max_episodes before coverage targets", flush=True)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
