#!/usr/bin/env python3
"""Flip_prob gradient at fixed mild sigma: summary metrics + full learning curves."""

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
    """Moving average with shrinking window at edges (no edge artifact)."""
    if len(xs) < 2:
        return xs
    half = max(1, win // 2)
    out = np.empty_like(xs, dtype=float)
    for i in range(len(xs)):
        lo = max(0, i - half)
        hi = min(len(xs), i + half + 1)
        out[i] = xs[lo:hi].mean()
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--seeds", type=int, default=8)
    p.add_argument("--seed0", type=int, default=200)
    p.add_argument("--sigma", type=float, default=0.15)
    p.add_argument("--flips", type=str, default="0,0.05,0.1,0.15,0.2,0.3,0.4")
    p.add_argument("--miss-prob", type=float, default=0.0)
    p.add_argument("--graph-mode", choices=["grid", "graph"], default="grid")
    p.add_argument("--cols", type=int, default=6)
    p.add_argument("--rows", type=int, default=5)
    p.add_argument("--nodes", type=int, default=24)
    p.add_argument("--out", type=str, default=str(ROOT / "results"))
    p.add_argument("--figures", type=str, default=str(ROOT / "figures"))
    args = p.parse_args()

    out = Path(args.out)
    fig_dir = Path(args.figures)
    out.mkdir(parents=True, exist_ok=True)
    fig_dir.mkdir(parents=True, exist_ok=True)

    flips = [float(x) for x in args.flips.split(",")]
    seeds = list(range(args.seeds))
    rows = []
    # (algo, flip) -> mean excess curve over episodes
    curves: dict[tuple[str, float], np.ndarray] = {}
    # (algo, flip) -> mean success curve (1 if reached else 0)
    success_curves: dict[tuple[str, float], np.ndarray] = {}

    for algo in ["qlearning", "tamer"]:
        for flip in flips:
            ep_mat = []
            succ_mat = []
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
                    seed=args.seed0 + seed,
                    sigma=args.sigma,
                    flip_prob=flip,
                    miss_prob=args.miss_prob,
                )
                result = run_training(cfg)
                summaries.append(result["summary"])
                excess = []
                succ = []
                for e in result["episodes"]:
                    if e["reached"]:
                        excess.append(e["steps"] - e["shortest"])
                    else:
                        excess.append(args.max_steps)
                    succ.append(1.0 if e["reached"] else 0.0)
                ep_mat.append(excess)
                succ_mat.append(succ)

            ep_mat_a = np.asarray(ep_mat, dtype=float)
            succ_mat_a = np.asarray(succ_mat, dtype=float)
            mean_curve = ep_mat_a.mean(axis=0)
            mean_succ = succ_mat_a.mean(axis=0)
            curves[(algo, flip)] = mean_curve
            success_curves[(algo, flip)] = mean_succ

            opt_ratios = [s["final_optimal_action_ratio"] for s in summaries]
            success20 = [s["last20_success"] for s in summaries]
            excess_last = [
                s["last20_mean_excess_steps"]
                for s in summaries
                if s["last20_mean_excess_steps"] == s["last20_mean_excess_steps"]
            ]
            converge = [s["converge_episode"] for s in summaries]

            row = {
                "algo": algo,
                "sigma": args.sigma,
                "flip_prob": flip,
                "miss_prob": args.miss_prob,
                "seeds": len(seeds),
                "mean_final_opt_ratio": float(np.mean(opt_ratios)),
                "std_final_opt_ratio": float(np.std(opt_ratios)),
                "mean_last20_success": float(np.mean(success20)),
                "mean_last20_excess": float(np.nanmean(excess_last)) if excess_last else float("nan"),
                "median_converge_ep": float(
                    np.nanmedian([c if c is not None else np.nan for c in converge])
                ),
                "converge_rate": float(np.mean([c is not None for c in converge])),
            }
            rows.append(row)
            print(
                f"{algo:10s} flip={flip:.2f}  "
                f"opt={row['mean_final_opt_ratio']:.3f}±{row['std_final_opt_ratio']:.3f}  "
                f"succ20={row['mean_last20_success']:.2f}  "
                f"excess20={row['mean_last20_excess']:.2f}"
            )

    path = out / "flip_sweep_summary.csv"
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    (out / "flip_sweep_summary.json").write_text(json.dumps(rows, indent=2))

    # Persist full curves for downstream analysis
    curve_payload = {
        "sigma": args.sigma,
        "episodes": args.episodes,
        "flips": flips,
        "excess": {
            f"{algo}|{flip}": curves[(algo, flip)].tolist()
            for algo in ["qlearning", "tamer"]
            for flip in flips
        },
        "success": {
            f"{algo}|{flip}": success_curves[(algo, flip)].tolist()
            for algo in ["qlearning", "tamer"]
            for flip in flips
        },
    }
    (out / "flip_learning_curves.json").write_text(json.dumps(curve_payload))

    # --- Figure 1: final opt ratio vs flip ---
    plt.figure(figsize=(7.5, 4.5))
    for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
        xs = [r["flip_prob"] for r in rows if r["algo"] == algo]
        ys = [r["mean_final_opt_ratio"] for r in rows if r["algo"] == algo]
        es = [r["std_final_opt_ratio"] for r in rows if r["algo"] == algo]
        plt.errorbar(xs, ys, yerr=es, marker="o", label=algo, color=color, capsize=3)
    plt.xlabel("Discrete flip probability")
    plt.ylabel("Final greedy optimal-action ratio")
    plt.title(f"Discrete decoder errors (σ={args.sigma} fixed)")
    plt.ylim(-0.05, 1.05)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.savefig(fig_dir / "opt_ratio_vs_flip.png", dpi=160)
    plt.close()

    # --- Figure 2: last-20 success vs flip ---
    plt.figure(figsize=(7.5, 4.5))
    for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
        xs = [r["flip_prob"] for r in rows if r["algo"] == algo]
        ys = [r["mean_last20_success"] for r in rows if r["algo"] == algo]
        plt.plot(xs, ys, marker="o", label=algo, color=color)
    plt.xlabel("Discrete flip probability")
    plt.ylabel("Success rate (last 20 episodes)")
    plt.title(f"Goal reachability under flips (σ={args.sigma})")
    plt.ylim(-0.05, 1.05)
    plt.grid(True, alpha=0.3)
    plt.legend()
    plt.tight_layout()
    plt.savefig(fig_dir / "success_vs_flip.png", dpi=160)
    plt.close()

    # --- Figure 3: FULL excess learning curves — one panel per flip ---
    n = len(flips)
    ncols = min(4, n)
    nrows = int(np.ceil(n / ncols))
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(4.0 * ncols, 3.2 * nrows), sharey=True, squeeze=False
    )
    for i, flip in enumerate(flips):
        ax = axes[i // ncols][i % ncols]
        for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
            curve = curves[(algo, flip)]
            ax.plot(np.arange(1, len(curve) + 1), smooth(curve), label=algo, color=color, lw=1.6)
        ax.set_title(f"flip = {flip}")
        ax.set_xlabel("Episode")
        ax.grid(True, alpha=0.3)
        if i % ncols == 0:
            ax.set_ylabel("Excess steps (smoothed)")
        if i == 0:
            ax.legend(fontsize=8)
    for j in range(n, nrows * ncols):
        axes[j // ncols][j % ncols].axis("off")
    fig.suptitle(
        f"Learning curves under discrete flip (σ={args.sigma}, all levels)",
        y=1.01,
    )
    fig.tight_layout()
    fig.savefig(fig_dir / "learning_curves_vs_flip.png", dpi=160, bbox_inches="tight")
    plt.close()

    # --- Figure 4: overlay all flips on one axes (per algo) — excess ---
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    cmap = plt.cm.viridis
    for ax, algo in zip(axes, ["qlearning", "tamer"]):
        for i, flip in enumerate(flips):
            color = cmap(i / max(1, len(flips) - 1))
            curve = curves[(algo, flip)]
            ax.plot(
                np.arange(1, len(curve) + 1),
                smooth(curve),
                color=color,
                lw=1.5,
                label=f"flip={flip}",
            )
        ax.set_title(algo)
        ax.set_xlabel("Episode")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=7, ncol=2, loc="upper right")
    axes[0].set_ylabel("Excess steps (smoothed)")
    fig.suptitle(f"Flip overlay — excess steps (σ={args.sigma})", y=1.02)
    fig.tight_layout()
    fig.savefig(fig_dir / "learning_curves_flip_overlay.png", dpi=160, bbox_inches="tight")
    plt.close()

    # --- Figure 5: FULL success learning curves — one panel per flip ---
    fig, axes = plt.subplots(
        nrows, ncols, figsize=(4.0 * ncols, 3.2 * nrows), sharey=True, squeeze=False
    )
    for i, flip in enumerate(flips):
        ax = axes[i // ncols][i % ncols]
        for algo, color in [("qlearning", "#5b8cff"), ("tamer", "#38d39f")]:
            curve = success_curves[(algo, flip)]
            ax.plot(np.arange(1, len(curve) + 1), smooth(curve), label=algo, color=color, lw=1.6)
        ax.set_title(f"flip = {flip}")
        ax.set_xlabel("Episode")
        ax.set_ylim(-0.05, 1.05)
        ax.grid(True, alpha=0.3)
        if i % ncols == 0:
            ax.set_ylabel("Episode success (smoothed)")
        if i == 0:
            ax.legend(fontsize=8)
    for j in range(n, nrows * ncols):
        axes[j // ncols][j % ncols].axis("off")
    fig.suptitle(
        f"Success learning curves under discrete flip (σ={args.sigma})",
        y=1.01,
    )
    fig.tight_layout()
    fig.savefig(fig_dir / "success_curves_vs_flip.png", dpi=160, bbox_inches="tight")
    plt.close()

    print(f"Wrote {path}")
    print(f"Wrote curves → {out / 'flip_learning_curves.json'}")
    print(f"Wrote figures → {fig_dir}")


if __name__ == "__main__":
    main()
