#!/usr/bin/env python3
"""Train Tetris DQN agent."""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import torch

from tetris_rl.agent import DqnAgent
from tetris_rl.env import TetrisEnv
from tetris_rl.evaluate import evaluate, random_baseline
from tetris_rl.heuristic import HeuristicPlanner


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--steps", type=int, default=150_000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--eval-every", type=int, default=10_000)
    parser.add_argument("--eval-seeds", type=int, default=8)
    parser.add_argument("--out", type=Path, default=Path("checkpoints"))
    parser.add_argument("--train-interval", type=int, default=4)
    parser.add_argument("--imitate-frac", type=float, default=0.85)
    parser.add_argument("--smoke", action="store_true")
    args = parser.parse_args()

    if args.smoke:
        args.steps = 2_000
        args.eval_every = 1_000

    args.out.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    agent = DqnAgent(device=device, seed=args.seed)
    env = TetrisEnv()
    obs, _ = env.reset(seed=args.seed)
    planner = HeuristicPlanner()

    eval_seeds = list(range(100, 100 + args.eval_seeds))
    history: list[dict] = []
    episode = 0
    t0 = time.time()

    for step in range(1, args.steps + 1):
        imitate = agent.rng.random() < args.imitate_frac * max(0.15, 1.0 - step / max(1, args.steps))
        if imitate:
            action = planner.act(env.state, env._rng_fn)
        else:
            action = agent.select_action(obs, explore=True)
        next_obs, reward, terminated, truncated, info = env.step(action)
        done = terminated or truncated
        agent.remember(obs, action, reward, next_obs, done)
        loss = None
        if step % args.train_interval == 0:
            loss = agent.train_step()
        obs = next_obs

        if step % 5000 == 0:
            elapsed = time.time() - t0
            print(
                f"[train] step={step} eps={agent.epsilon:.3f} episodes={episode} elapsed={elapsed:.1f}s",
                flush=True,
            )

        if done:
            episode += 1
            planner = HeuristicPlanner()
            obs, _ = env.reset(seed=args.seed + episode)

        if step % args.eval_every == 0 or step == args.steps:
            metrics = evaluate(agent, eval_seeds)
            elapsed = time.time() - t0
            record = {
                "step": step,
                "epsilon": agent.epsilon,
                "loss": loss,
                "episode": episode,
                "elapsed_sec": elapsed,
                **metrics,
            }
            history.append(record)
            print(json.dumps(record, ensure_ascii=False))

            ckpt = args.out / f"dqn_step_{step}.pt"
            torch.save(
                {
                    "step": step,
                    "policy": agent.policy.state_dict(),
                    "metrics": metrics,
                },
                ckpt,
            )

    random_metrics = random_baseline(eval_seeds)
    summary = {
        "trained_steps": args.steps,
        "history": history,
        "random_baseline": random_metrics,
        "final_eval": history[-1] if history else {},
    }
    summary_path = args.out / "train_summary.json"
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    final_ckpt = args.out / "dqn_latest.pt"
    torch.save({"step": args.steps, "policy": agent.policy.state_dict()}, final_ckpt)
    print(f"Saved {final_ckpt}")


if __name__ == "__main__":
    main()
