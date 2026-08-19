#!/usr/bin/env python3
"""Roll out one greedy episode and print the policy's behavior."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import numpy as np
import torch

from tetris_rl.config import TrainConfig
from tetris_rl.encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from tetris_rl.engine import COLS, ROWS, RL_ACTION_NAMES
from tetris_rl.env import TetrisEnv
from tetris_rl.model import ActorCritic

CKPT = Path("runs/ppo_h20_wide/ckpt/step_262144.pt")
SEED = 10_000
MAX_STEPS = 200


def ascii_board(state) -> str:
    cells = [row[:] for row in state.board]
    if state.piece:
        for r, row in enumerate(state.piece.matrix):
            for c, val in enumerate(row):
                if not val:
                    continue
                x = state.piece.x + c
                y = state.piece.y + r
                if 0 <= y < ROWS and 0 <= x < COLS:
                    cells[y][x] = -1
    out = []
    for r in range(ROWS):
        out.append("".join("#" if v > 0 else "@" if v < 0 else "." for v in cells[r]))
    piece = state.piece
    extra = f"piece={piece.type} rot={piece.rot} x={piece.x} y={piece.y}" if piece else "piece=None"
    return "\n".join(out) + f"\n{extra} next={state.next} lines={state.lines} over={state.game_over}"


def pack(buf: np.ndarray) -> np.ndarray:
    k, c, h, w = buf.shape
    return buf.reshape(k * c, h, w)


def main() -> None:
    print(f"loading {CKPT} ...", flush=True)
    payload = torch.load(CKPT, map_location="cpu", weights_only=False)
    cfg = TrainConfig.from_dict(payload.get("config") or {})
    k = max(1, cfg.frame_stack)
    stride = max(1, cfg.frame_stride)
    net = ActorCritic(
        width=cfg.width,
        hidden=cfg.hidden,
        depth=cfg.depth,
        in_channels=RL_OBS_CHANNELS * k,
    )
    step = payload.get("env_steps") or payload.get("step")
    net.load_state_dict(payload["policy"])
    net.eval()
    del payload
    print(f"loaded env_steps={step} stack={k} stride={stride}", flush=True)

    env = TetrisEnv(gravity_min=cfg.gravity_min, gravity_max=cfg.gravity_max)
    obs, _ = env.reset(seed=SEED)
    buf = np.repeat(obs[None], k, axis=0)
    counts: Counter[str] = Counter()
    snapshots = []
    logit_snaps = []

    with torch.no_grad():
        for t in range(MAX_STEPS):
            x = torch.from_numpy(pack(buf)[None])
            logits, value = net(x)
            probs = torch.softmax(logits[0], dim=0).numpy()
            action = int(logits[0].argmax().item())
            name = RL_ACTION_NAMES[action]
            counts[name] += 1
            p = env.state.piece
            rec = {
                "t": t,
                "action": name,
                "probs": {RL_ACTION_NAMES[i]: float(probs[i]) for i in range(len(RL_ACTION_NAMES))},
                "value": float(value[0]),
                "piece": None if p is None else f"{p.type}@{p.x},{p.y} r{p.rot}",
                "lines": env.state.lines,
            }
            if t < 40 or t % 20 == 0:
                snapshots.append((t, name, ascii_board(env.state), rec))
            if t in (0, 10, 50) or t == MAX_STEPS - 1:
                logit_snaps.append((t, rec))
            obs, _, terminated, truncated, info = env.step(action)
            if terminated or truncated:
                snapshots.append((t + 1, "DEAD", ascii_board(env.state), rec))
                print(f"\n=== episode ended at step {t+1} lines={info['lines']} score={info['score']} ===")
                break
            count = t + 1
            if k > 1 and count % stride == 0:
                buf[:-1] = buf[1:]
            buf[-1] = obs
        else:
            print(f"\n=== hit max_steps={MAX_STEPS} lines={env.state.lines} ===")

    print("\naction counts:", dict(counts))
    print(f"unique actions: {sorted(counts)}")
    print(f"gravity={env._cells_per_sec:.2f} cells/s  seed={SEED}")

    print("\n--- first 30 actions ---")
    for t, name, board, rec in snapshots:
        if t >= 30 and name != "DEAD":
            continue
        p = rec["probs"]
        top = max(p, key=p.get)
        print(f"t={t:3d} {name:10s} piece={rec['piece']}  P({top})={p[top]:.3f}  V={rec['value']:.2f}")

    print("\n--- board at t=0 ---")
    print(snapshots[0][2])
    print("\n--- board ~t=20 ---")
    mid = next((s for s in snapshots if s[0] >= 20), snapshots[-1])
    print(f"t={mid[0]} action={mid[1]}")
    print(mid[2])
    print("\n--- last board ---")
    print(snapshots[-1][2])

    print("\n--- softmax at a few steps ---")
    for t, rec in logit_snaps:
        pretty = "  ".join(f"{n}:{rec['probs'][n]:.2f}" for n in RL_ACTION_NAMES)
        print(f"t={t:3d} {pretty}")


if __name__ == "__main__":
    main()
