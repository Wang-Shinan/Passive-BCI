#!/usr/bin/env python3
"""Generate the two main figures from a completed run."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/gjc-matplotlib")
os.environ.setdefault("MPLBACKEND", "Agg")

import matplotlib.pyplot as plt
import numpy as np


COLORS = {
    "neural": "#2364aa",
    "behavior": "#e69f00",
    "gain": "#6a4c93",
    "unsafe": "#cc79a7",
    "guarded": "#0072b2",
    "truth": "#264653",
}


def plot(run_dir: Path) -> None:
    data = json.loads((run_dir / "final_info.json").read_text())
    curve = sorted(
        data["noise_sensitivity"],
        key=lambda row: row["effective_accuracy"],
    )
    xs = np.asarray([row["effective_accuracy"] for row in curve]) * 100.0
    neural_mae = [row["neural_event_mae"] for row in curve]
    baseline_mae = [row["behavioral_event_mae"] for row in curve]
    gain = [row["mae_gain_fraction"] * 100.0 for row in curve]

    plt.rcParams.update(
        {
            "font.size": 9,
            "axes.labelsize": 9,
            "legend.fontsize": 8,
            "xtick.labelsize": 8,
            "ytick.labelsize": 8,
        }
    )
    fig, left = plt.subplots(figsize=(7.2, 4.4))
    left.plot(xs, neural_mae, "o-", color=COLORS["neural"], label="Neural + behavior")
    left.plot(
        xs,
        baseline_mae,
        "--",
        color=COLORS["behavior"],
        label="Behavior only",
    )
    left.set_xlabel("Effective single-shot accuracy (%)")
    left.set_ylabel("Per-role event credit MAE (lower is better)")
    left.grid(alpha=0.22)
    right = left.twinx()
    right.plot(xs, gain, "s:", color=COLORS["gain"], label="MAE gain")
    right.set_ylabel("Gain over behavior only (%)")
    handles, labels = left.get_legend_handles_labels()
    handles2, labels2 = right.get_legend_handles_labels()
    left.legend(handles + handles2, labels + labels2, frameon=False, loc="best")
    fig.tight_layout()
    fig.savefig(run_dir / "Figure_1.png", dpi=320)
    fig.savefig(run_dir / "Figure_1.pdf")
    plt.close(fig)

    checkpoint = data["checkpoint_comparison"]
    pathology = data["pathology"]
    grid = pathology["grid"]
    actions = [point["load_action"] for point in grid]
    apparent = [point["apparent_violation_rate"] for point in grid]
    truth = [point["true_violation_rate"] for point in grid]
    supply = [point["verdict_supply"] for point in grid]

    fig, axes = plt.subplots(1, 2, figsize=(10.8, 4.2))
    bars = axes[0].bar(
        ["No checkpoints", "Checkpoints"],
        [
            checkpoint["off"]["silent_timeout_rate_among_timeouts"] * 100.0,
            checkpoint["on"]["silent_timeout_rate_among_timeouts"] * 100.0,
        ],
        color=["#999999", COLORS["neural"]],
    )
    axes[0].bar_label(bars, fmt="%.1f", padding=3, fontsize=8)
    axes[0].set_ylabel("Silent timeouts (%)")
    axes[0].grid(axis="y", alpha=0.22)
    axes[0].text(
        0.02,
        0.98,
        "(a)",
        transform=axes[0].transAxes,
        va="top",
        fontweight="bold",
    )

    axes[1].plot(
        actions, truth, "o-", label="True violations", color=COLORS["truth"]
    )
    axes[1].plot(
        actions,
        apparent,
        "s-",
        label="Apparent violations",
        color=COLORS["unsafe"],
    )
    axes[1].plot(
        actions,
        supply,
        "^-",
        label="Verdict supply",
        color="#e9c46a",
    )
    admissible_actions = [
        point["load_action"] for point in grid if point["admissible"]
    ]
    step = min(np.diff(sorted(set(actions)))) if len(actions) > 1 else 0.25
    axes[1].axvspan(
        min(admissible_actions) - step / 2,
        max(admissible_actions) + step / 2,
        color=COLORS["guarded"],
        alpha=0.10,
        label="Admissible load band",
    )
    unsafe = pathology["unsafe"]
    guarded = pathology["guarded"]
    axes[1].scatter(
        [unsafe["load_action"]],
        [unsafe["apparent_violation_rate"]],
        marker="X",
        s=75,
        color=COLORS["unsafe"],
        edgecolor="black",
        linewidth=0.5,
        zorder=5,
        label="Unsafe choice",
    )
    axes[1].scatter(
        [guarded["load_action"]],
        [guarded["apparent_violation_rate"]],
        marker="*",
        s=100,
        color=COLORS["guarded"],
        edgecolor="black",
        linewidth=0.5,
        zorder=5,
        label="Guarded choice",
    )
    axes[1].set_xlabel("Load-driving action")
    axes[1].set_ylabel("Rate")
    axes[1].grid(alpha=0.22)
    axes[1].legend(frameon=False, fontsize=7, ncol=2, loc="upper right")
    axes[1].text(
        0.02,
        0.98,
        "(b)",
        transform=axes[1].transAxes,
        va="top",
        fontweight="bold",
    )
    fig.tight_layout()
    fig.savefig(run_dir / "Figure_2.png", dpi=320)
    fig.savefig(run_dir / "Figure_2.pdf")
    plt.close(fig)

    print(f"Wrote {run_dir / 'Figure_1.png'}")
    print(f"Wrote {run_dir / 'Figure_1.pdf'}")
    print(f"Wrote {run_dir / 'Figure_2.png'}")
    print(f"Wrote {run_dir / 'Figure_2.pdf'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    args = parser.parse_args()
    plot(Path(args.run_dir))


if __name__ == "__main__":
    main()
