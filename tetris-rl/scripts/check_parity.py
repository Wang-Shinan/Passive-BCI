#!/usr/bin/env python3
"""Verify Python engine matches TypeScript parity fixtures."""

from __future__ import annotations

import json
from pathlib import Path

from tetris_rl.engine import board_fingerprint, create_game, rl_step
from tetris_rl.rng import mulberry32

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "parity_trajectories.json"


def main() -> int:
    fixtures = json.loads(FIXTURES.read_text())
    failed = 0
    for fixture in fixtures:
        seed = fixture["seed"]
        cells = fixture["cellsPerSec"]
        rng = mulberry32(seed)
        state = create_game(seed)
        fps = [board_fingerprint(state)]
        for action in fixture["actions"]:
            state = rl_step(state, action, rng, cells, instant_anim=True)
            fps.append(board_fingerprint(state))
        if fps != fixture["fingerprints"]:
            print(f"FAIL {fixture['name']}")
            for i, (got, exp) in enumerate(zip(fps, fixture["fingerprints"])):
                if got != exp:
                    print(f"  step {i}:")
                    print(f"    got: {got}")
                    print(f"    exp: {exp}")
            failed += 1
        else:
            print(f"OK   {fixture['name']}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
