"""Export DQN / PPO / BC checkpoints to the browser ONNX contract."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import torch

from .config import TrainConfig
from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .engine import RL_ACTION_NAMES, RL_DECISION_DT_SEC
from .model import ActorCritic, DuelingDQN, PQNNet, TetrisDQN


class LogitsWrapper(torch.nn.Module):
    def __init__(self, net: torch.nn.Module, kind: str):
        super().__init__()
        self.net = net
        self.kind = kind

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if self.kind in {"ppo", "bc", "bc_ppo", "dagger", "iql"}:
            return self.net.logits(x)
        return self.net(x)


def build_export_model(payload: dict) -> torch.nn.Module:
    kind = payload.get("kind") or "dqn"
    cfg = TrainConfig.from_dict(payload.get("config") or {})
    width = int(payload.get("width") or cfg.width)
    hidden = int(payload.get("hidden") or cfg.hidden)
    depth = int(payload.get("depth") or cfg.depth)
    in_channels = int(
        payload.get("in_channels") or (RL_OBS_CHANNELS * max(1, int(getattr(cfg, "frame_stack", 1))))
    )
    state = payload["policy"]
    if kind in {"ppo", "bc", "bc_ppo", "dagger", "iql"} or any(k.startswith("policy.") for k in state):
        net: torch.nn.Module = ActorCritic(
            width=width, hidden=hidden, depth=depth, in_channels=in_channels
        )
        wrap_kind = "ppo"
    elif kind == "pqn" or any(k == "ln.weight" for k in state):
        net = PQNNet(width=width, hidden=hidden, depth=depth, in_channels=in_channels)
        wrap_kind = "dqn"
    elif any(k.startswith("adv.") for k in state) or payload.get("dueling") is True:
        net = DuelingDQN(width=width, hidden=hidden, depth=depth, in_channels=in_channels)
        wrap_kind = "dqn"
    else:
        net = TetrisDQN()
        wrap_kind = "dqn"
    net.load_state_dict(state)
    net.eval()
    return LogitsWrapper(net, wrap_kind)


def export_checkpoint(
    checkpoint: Path,
    out_dir: Path,
    eval_mean_lines: float | None = None,
) -> tuple[Path, Path]:
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    model = build_export_model(payload)
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "tetris-dqn.onnx"
    meta_path = out_dir / "metadata.json"
    cfg = payload.get("config") or {}
    frame_stack = max(1, int(cfg.get("frame_stack") or 1))
    in_channels = int(payload.get("in_channels") or (RL_OBS_CHANNELS * frame_stack))
    dummy = torch.zeros(1, in_channels, RL_OBS_ROWS, RL_OBS_COLS)
    torch.onnx.export(
        model,
        dummy,
        onnx_path,
        input_names=["observation"],
        output_names=["q_values"],
        dynamic_axes={"observation": {0: "batch"}, "q_values": {0: "batch"}},
        opset_version=17,
    )
    metadata = {
        "version": 1,
        "kind": payload.get("kind") or "dqn",
        "actionNames": RL_ACTION_NAMES,
        "decisionIntervalMs": int(RL_DECISION_DT_SEC * 1000),
        "obsChannels": in_channels,
        "obsRows": RL_OBS_ROWS,
        "obsCols": RL_OBS_COLS,
        "frameStack": frame_stack,
        "frameStride": int(cfg.get("frame_stride") or 1),
        "contextSec": max(1, frame_stack) * max(1, int(cfg.get("frame_stride") or 1)) * RL_DECISION_DT_SEC,
        "gravityMin": cfg.get("gravity_min", 1.0),
        "gravityMax": cfg.get("gravity_max", 6.0),
        "trainedSteps": payload.get("env_steps") or payload.get("step"),
        "evalMeanLines": eval_mean_lines
        if eval_mean_lines is not None
        else (payload.get("metrics") or {}).get("mean_lines"),
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "checkpoint": str(checkpoint),
    }
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"Exported {onnx_path}")
    print(f"Exported {meta_path}")
    return onnx_path, meta_path
