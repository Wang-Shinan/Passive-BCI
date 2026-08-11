#!/usr/bin/env python3
"""Sweep noise gradient × {Q-learning, TAMER} and write results + figures."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from oracle_eval.train import TrainConfig, run_training  # noqa: E402


def smooth(xs: np.ndarray, win: int = 11) -> np.ndarray:
    if len(xs) < win:
        return xs
    kernel = np.ones(win) / win
    return np.convolve(xs, kernel, mode="same")


def run_sweep(args: argparse.Namespace) -> None:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    fig_dir = Path(args.figures)
    fig_dir.mkdir(parents=True, exist_ok=True)

    sigmas = [float(x) for x in args.sigmas.split(",")]
    algos = ["qlearning", "tamer"]
    seeds = list(range(args.seeds))

    rows = []
    curves = {}  # (algo, sigma) -> list of mean excess over episodes (avg seeds)

    for algo in algos:
        for sigma in sigmas:
            ep_mat = []
            summaries = []
            for seed in seeds:
                cfg = TrainConfig(
                    algo=algo,  # type: ignore[arg-type]
                    episodes=args.episodes,
                    max_steps=args.max_steps,
                    graph_mode=args.graph_mode,
                    grid_cols=args.cols,
                    grid_rows=args.rows,
                    node_count=args.nodes,
                    seed=seed + args.seed0,
                    sigma=sigma,
                    flip_prob=args.flip_prob,
                    miss_prob=args.miss_prob,
                )
                result = run_training(cfg)
                summaries.append(result["summary"])
                excess = []
                for e in result["episodes"]:
                    if e["reached"]:
                        excess.append(e["steps"] - e["shortest"])
                    else:
                        excess.append(args.max_steps)  # failure penalty for curve
                ep_mat.append(excess)

            ep_mat_a = np.asarray(ep_mat, dtype=float)
            mean_curve = ep_mat_a.mean(axis=0)
            curves[(algo, sigma)] = mean_curve

            opt_ratios = [s["final_optimal_action_ratio"] for s in summaries]
            success = [s["last20_success"] for s in summaries]
            excess_last = [
                s["last20_mean_excess_steps"]
                for s in summaries
                if s["last20_mean_excess_steps"] == s["last20_mean_excess_steps"]
            ]
            converge = [s["converge_episode"] for s in summaries]

            row = {
                "algo": algo,
                "sigma": sigma,
                "flip_prob": args.flip_prob,
                "miss_prob": args.miss_prob,
                "seeds": len(seeds),
                "mean_final_opt_ratio": float(np.mean(opt_ratios)),
                "std_final_opt_ratio": float(np.std(opt_ratios)),
                "mean_last20_success": float(np.mean(success)),
                "mean_last20_excess": float(np.nanmean(excess_last)) if excess_last else float("nan"),
                "median_converge_ep": float(np.nanmedian([c if c is not None else np.nan for c in converge])),
                "converge_rate": float(np.mean([c is not None for c in converge])),
            }
            rows.append(row)
            print(
                f"{algo:10s} σ={sigma:.2f}  opt={row['mean_final_opt_ratio']:.3f}±{row['std_final_opt_ratio']:.3f}  "
                f"succ20={row['mean_last20_success']:.2f}  excess20={row['mean_last20_excess']:.2f}  "
                f"conv={row['converge_rate']:.2f}@{row['median_converge_ep']}"
            )

    # CSV
    csv_path = out / "noise_sweep_summary.csv"
    with csv_path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)

    json_path = out / "noise_sweep_summary.json"
    json_path.write_text(json.dumps(rows, indent=2))

    # Figure 1: final optimal-action ratio vs sigma
    plt.figure(figsize=(7.5, 4.5))
    for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
        xs = [r["sigma"] for r in rows if r["algo"] == algo]
        ys = [r["mean_final_opt_ratio"] for r in rows if r["algo"] == algo]
        es = [r["std_final_opt_ratio"] for r in rows if r["algo"] == algo]
        plt.errorbar(xs, ys, yerr=es, marker="o", label=algo, color=color, capsize=3)
    plt.xlabel("Rating noise σ (Gaussian)")
    plt.ylabel("Final greedy optimal-action ratio")
    plt.title("Decoder noise tolerance: policy quality")
    plt.ylim(-0.05, 1.05)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.savefig(fig_dir / "opt_ratio_vs_sigma.png", dpi=160)
    plt.close()

    # Figure 2: last-20 success vs sigma
    plt.figure(figsize=(7.5, 4.5))
    for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
        xs = [r["sigma"] for r in rows if r["algo"] == algo]
        ys = [r["mean_last20_success"] for r in rows if r["algo"] == algo]
        plt.plot(xs, ys, marker="o", label=algo, color=color)
    plt.xlabel("Rating noise σ")
    plt.ylabel("Success rate (last 20 episodes)")
    plt.title("Decoder noise tolerance: goal reachability")
    plt.ylim(-0.05, 1.05)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.savefig(fig_dir / "success_vs_sigma.png", dpi=160)
    plt.close()

    # Figure 3: learning curves at selected sigmas
    show_sigmas = [sigmas[0], sigmas[len(sigmas) // 2], sigmas[-1]]
    fig, axes = plt.subplots(1, len(show_sigmas), figsize=(4.2 * len(show_sigmas), 3.6), sharey=True)
    if len(show_sigmas) == 1:
        axes = [axes]
    for ax, sigma in zip(axes, show_sigmas):
        for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
            curve = curves[(algo, sigma)]
            ax.plot(np.arange(1, len(curve) + 1), smooth(curve), label=algo, color=color)
        ax.set_title(f"σ = {sigma}")
        ax.set_xlabel("Episode")
        ax.grid(True, alpha=0.3)
    axes[0].set_ylabel("Excess steps (smoothed)")
    axes[0].legend()
    fig.suptitle("Learning curves under noise", y=1.02)
    fig.tight_layout()
    fig.savefig(fig_dir / "learning_curves.png", dpi=160, bbox_inches="tight")
    plt.close()

    # Figure 4: converge rate vs sigma
    plt.figure(figsize=(7.5, 4.5))
    for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
        xs = [r["sigma"] for r in rows if r["algo"] == algo]
        ys = [r["converge_rate"] for r in rows if r["algo"] == algo]
        plt.plot(xs, ys, marker="o", label=algo, color=color)
    plt.xlabel("Rating noise σ")
    plt.ylabel("Fraction of seeds converging")
    plt.title("Near-optimal streak (≥5 eps within +1 of shortest)")
    plt.ylim(-0.05, 1.05)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.savefig(fig_dir / "converge_vs_sigma.png", dpi=160)
    plt.close()

    print(f"\nWrote {csv_path}")
    print(f"Wrote figures to {fig_dir}")


def main() -> None:
    p = argparse.ArgumentParser(description="Oracle-path noise sweep for Q vs TAMER")
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--seeds", type=int, default=8)
    p.add_argument("--seed0", type=int, default=100)
    p.add_argument("--sigmas", type=str, default="0,0.1,0.2,0.3,0.4,0.5,0.6,0.8")
    p.add_argument("--flip-prob", type=float, default=0.0)
    p.add_argument("--miss-prob", type=float, default=0.0)
    p.add_argument("--graph-mode", choices=["grid", "graph"], default="grid")
    p.add_argument("--cols", type=int, default=6)
    p.add_argument("--rows", type=int, default=5)
    p.add_argument("--nodes", type=int, default=24)
    p.add_argument("--out", type=str, default=str(ROOT / "results"))
    p.add_argument("--figures", type=str, default=str(ROOT / "figures"))
    args = p.parse_args()
    run_sweep(args)


if __name__ == "__main__":
    main()
