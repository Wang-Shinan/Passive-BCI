#!/usr/bin/env python3
"""Verify Python engine matches TypeScript parity fixtures."""

from __future__ import annotations

import json
from pathlib import Path

from tetris_rl.engine import RL_ACTION_NAMES, board_fingerprint, create_game, rl_step
from tetris_rl.rng import mulberry32


def main() -> None:
    fixture_path = Path(__file__).resolve().parents[1] / "fixtures" / "parity_trajectories.json"
    fixtures = json.loads(fixture_path.read_text(encoding="utf-8"))

    for fixture in fixtures:
        seed = fixture["seed"]
        cells_per_sec = fixture["cellsPerSec"]
        actions = fixture["actions"]
        expected = fixture["fingerprints"]

        rng = mulberry32(seed)
        state = create_game(seed)
        fps = [board_fingerprint(state)]

        for action_name in actions:
            state = rl_step(state, action_name, rng, cells_per_sec, instant_anim=True)
            fps.append(board_fingerprint(state))

        if fps != expected:
            print(f"FAIL {fixture['name']}")
            for i, (got, exp) in enumerate(zip(fps, expected)):
                if got != exp:
                    print(f"  step {i}:")
                    print(f"    got: {got}")
                    print(f"    exp: {exp}")
            raise SystemExit(1)
        print(f"OK {fixture['name']} ({len(actions)} actions)")


if __name__ == "__main__":
    main()
