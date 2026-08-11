#!/usr/bin/env python3
"""Compare reward modes: oracle vs fully-random vs random+keep-goal."""

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

MODES = ("oracle", "random_keep_goal", "random")
MODE_LABEL = {
    "oracle": "oracle",
    "random_keep_goal": "random + keep goal",
    "random": "fully random",
}
MODE_COLOR = {
    "oracle": "#38d39f",
    "random_keep_goal": "#f5a524",
    "random": "#ff5d6c",
}
ALGO_STYLE = {"qlearning": "-", "tamer": "--"}


def smooth(xs: np.ndarray, win: int = 11) -> np.ndarray:
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
    p = argparse.ArgumentParser(description="Random-reward baseline curves")
    p.add_argument("--episodes", type=int, default=200)
    p.add_argument("--max-steps", type=int, default=60)
    p.add_argument("--seeds", type=int, default=12)
    p.add_argument("--seed0", type=int, default=300)
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

    seeds = list(range(args.seeds))
    rows = []
    excess_curves: dict[tuple[str, str], np.ndarray] = {}
    success_curves: dict[tuple[str, str], np.ndarray] = {}

    for algo in ("qlearning", "tamer"):
        for mode in MODES:
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
                    reward_mode=mode,  # type: ignore[arg-type]
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

            mean_excess = np.asarray(ep_mat, dtype=float).mean(axis=0)
            mean_succ = np.asarray(succ_mat, dtype=float).mean(axis=0)
            excess_curves[(algo, mode)] = mean_excess
            success_curves[(algo, mode)] = mean_succ

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
                "reward_mode": mode,
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
                f"{algo:10s} {mode:18s}  "
                f"opt={row['mean_final_opt_ratio']:.3f}±{row['std_final_opt_ratio']:.3f}  "
                f"succ20={row['mean_last20_success']:.2f}  "
                f"excess20={row['mean_last20_excess']:.2f}"
            )

    csv_path = out / "random_reward_summary.csv"
    with csv_path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    (out / "random_reward_summary.json").write_text(json.dumps(rows, indent=2))
    (out / "random_reward_curves.json").write_text(
        json.dumps(
            {
                "episodes": args.episodes,
                "modes": list(MODES),
                "excess": {
                    f"{a}|{m}": excess_curves[(a, m)].tolist()
                    for a in ("qlearning", "tamer")
                    for m in MODES
                },
                "success": {
                    f"{a}|{m}": success_curves[(a, m)].tolist()
                    for a in ("qlearning", "tamer")
                    for m in MODES
                },
            }
        )
    )

    # --- Figure 1: excess learning curves, one panel per algo ---
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    for ax, algo in zip(axes, ("qlearning", "tamer")):
        for mode in MODES:
            curve = excess_curves[(algo, mode)]
            ax.plot(
                np.arange(1, len(curve) + 1),
                smooth(curve),
                color=MODE_COLOR[mode],
                lw=1.8,
                label=MODE_LABEL[mode],
            )
        ax.set_title(algo)
        ax.set_xlabel("Episode")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
    axes[0].set_ylabel("Excess steps (smoothed)")
    fig.suptitle("Learning curves: oracle vs random reward modes", y=1.02)
    fig.tight_layout()
    fig.savefig(fig_dir / "learning_curves_random_reward.png", dpi=160, bbox_inches="tight")
    plt.close()

    # --- Figure 2: success learning curves ---
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), sharey=True)
    for ax, algo in zip(axes, ("qlearning", "tamer")):
        for mode in MODES:
            curve = success_curves[(algo, mode)]
            ax.plot(
                np.arange(1, len(curve) + 1),
                smooth(curve),
                color=MODE_COLOR[mode],
                lw=1.8,
                label=MODE_LABEL[mode],
            )
        ax.set_title(algo)
        ax.set_xlabel("Episode")
        ax.set_ylim(-0.05, 1.05)
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
    axes[0].set_ylabel("Episode success (smoothed)")
    fig.suptitle("Success curves: oracle vs random reward modes", y=1.02)
    fig.tight_layout()
    fig.savefig(fig_dir / "success_curves_random_reward.png", dpi=160, bbox_inches="tight")
    plt.close()

    # --- Figure 3: final opt-ratio bar ---
    fig, ax = plt.subplots(figsize=(7.5, 4.2))
    x = np.arange(len(MODES))
    width = 0.35
    for i, algo in enumerate(("qlearning", "tamer")):
        ys = [next(r["mean_final_opt_ratio"] for r in rows if r["algo"] == algo and r["reward_mode"] == m) for m in MODES]
        es = [next(r["std_final_opt_ratio"] for r in rows if r["algo"] == algo and r["reward_mode"] == m) for m in MODES]
        ax.bar(
            x + (i - 0.5) * width,
            ys,
            width,
            yerr=es,
            label=algo,
            color="#5b8cff" if algo == "qlearning" else "#38d39f",
            capsize=3,
            alpha=0.9,
        )
    ax.set_xticks(x)
    ax.set_xticklabels([MODE_LABEL[m] for m in MODES])
    ax.set_ylabel("Final greedy optimal-action ratio")
    ax.set_ylim(-0.05, 1.05)
    ax.set_title("Policy quality under reward modes")
    ax.grid(True, axis="y", alpha=0.3)
    ax.legend()
    fig.tight_layout()
    fig.savefig(fig_dir / "opt_ratio_vs_reward_mode.png", dpi=160)
    plt.close()

    # --- Figure 4: overlay both algos × modes on one excess plot ---
    fig, ax = plt.subplots(figsize=(8.5, 4.8))
    for algo in ("qlearning", "tamer"):
        for mode in MODES:
            curve = excess_curves[(algo, mode)]
            ax.plot(
                np.arange(1, len(curve) + 1),
                smooth(curve),
                color=MODE_COLOR[mode],
                ls=ALGO_STYLE[algo],
                lw=1.6,
                label=f"{algo} · {MODE_LABEL[mode]}",
            )
    ax.set_xlabel("Episode")
    ax.set_ylabel("Excess steps (smoothed)")
    ax.set_title("All conditions overlay")
    ax.grid(True, alpha=0.3)
    ax.legend(fontsize=7, ncol=2)
    fig.tight_layout()
    fig.savefig(fig_dir / "learning_curves_random_reward_overlay.png", dpi=160)
    plt.close()

    print(f"Wrote {csv_path}")
    print(f"Wrote figures → {fig_dir}")


if __name__ == "__main__":
    main()
