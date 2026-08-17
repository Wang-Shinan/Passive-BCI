"""Server-ready training loop: DQN / PPO / BC / BC→PPO."""

from __future__ import annotations

import json
import os
import signal
import time
from datetime import datetime, timezone
from pathlib import Path
from random import Random
from typing import Any

import numpy as np
import torch

from .algos.bc import BCLearner
from .algos.dqn import DQNLearner
from .algos.ppo import PPOLearner
from .config import TrainConfig, resolve_device
from .evaluate import evaluate_act, heuristic_baseline, random_baseline
from .heuristic import HeuristicPlanner
from .vec_env import SyncVectorEnv


def make_learner(cfg: TrainConfig, device: torch.device, obs_shape: tuple[int, ...]):
    if cfg.algo == "dqn":
        return DQNLearner(cfg, device, obs_shape)
    if cfg.algo == "ppo":
        return PPOLearner(cfg, device, cfg.num_envs, obs_shape)
    if cfg.algo in ("bc", "bc_ppo"):
        return BCLearner(cfg, device, obs_shape)
    raise ValueError(f"unknown algo {cfg.algo}")


def _gpu_banner(device: torch.device) -> str:
    if device.type != "cuda":
        return f"device=cpu"
    props = torch.cuda.get_device_properties(device)
    gb = props.total_memory / (1024**3)
    return f"device=cuda:{torch.cuda.get_device_name(device)} ({gb:.0f} GiB)"


def _act_fn(learner):
    def fn(obs: np.ndarray) -> int:
        return int(learner.act(obs[None], explore=False)[0])

    return fn


def _save(path: Path, cfg: TrainConfig, learner, extra: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "step": learner.env_steps,
        "config": cfg.to_dict(),
        **learner.checkpoint(),
        **extra,
    }
    torch.save(payload, path)


def train(cfg: TrainConfig) -> dict[str, Any]:
    device = torch.device(resolve_device(cfg.device))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    run_name = cfg.run_name or f"{cfg.algo}_{stamp}"
    run_dir = Path(cfg.run_dir) / run_name
    ckpt_dir = run_dir / "ckpt"
    run_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(cfg.to_dict(), indent=2), encoding="utf-8")
    metrics_path = run_dir / "metrics.jsonl"

    print(
        f"[tetris-rl] algo={cfg.algo} steps={cfg.steps} envs={cfg.num_envs} {_gpu_banner(device)}",
        flush=True,
    )
    print(f"[tetris-rl] run_dir={run_dir.resolve()}", flush=True)

    vec = SyncVectorEnv(
        cfg.num_envs,
        cfg.seed,
        gravity_min=cfg.gravity_min,
        gravity_max=cfg.gravity_max,
    )
    learner = make_learner(cfg, device, vec.obs_shape)
    if cfg.resume:
        resume_path = Path(cfg.resume)
        if cfg.resume == "auto":
            resume_path = ckpt_dir / "latest.pt"
        if resume_path.exists():
            payload = torch.load(resume_path, map_location=device, weights_only=False)
            learner.load(payload)
            print(f"[tetris-rl] resumed {resume_path} at env_steps={learner.env_steps}", flush=True)

    obs = vec.reset(cfg.seed)
    planners = [HeuristicPlanner() for _ in range(cfg.num_envs)]
    rng = Random(cfg.seed + 1)
    phase = "bc" if cfg.algo in ("bc", "bc_ppo") else cfg.algo
    stop = False

    def _handle(signum, _frame):
        nonlocal stop
        stop = True
        print(f"[tetris-rl] signal {signum}, will save and exit", flush=True)

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)

    torch.manual_seed(cfg.seed)
    np.random.seed(cfg.seed)

    eval_seeds = list(range(10_000, 10_000 + cfg.eval_seeds))
    baselines: dict[str, Any] = {}
    if cfg.compute_baselines:
        print("[tetris-rl] computing random + heuristic baselines (once)", flush=True)
        baselines = {
            "random": random_baseline(eval_seeds[: min(8, len(eval_seeds))]),
            "heuristic": heuristic_baseline(
                eval_seeds[: min(8, len(eval_seeds))],
                max_steps=min(400, cfg.eval_max_steps),
                gravity_min=cfg.gravity_min,
                gravity_max=cfg.gravity_max,
            ),
        }
        print(json.dumps({"baselines": baselines}, ensure_ascii=False), flush=True)
        (run_dir / "baselines.json").write_text(json.dumps(baselines, indent=2), encoding="utf-8")

    t0 = time.time()
    last_eval: dict[str, Any] = {}
    history: list[dict[str, Any]] = []
    last_metrics: dict[str, float] = {}
    next_log = cfg.log_every
    next_eval = cfg.eval_every
    next_ckpt = cfg.ckpt_every

    while learner.env_steps < cfg.steps and not stop:
        if phase == "bc":
            actions = np.array(
                [planners[i].act(vec.envs[i].state, vec.envs[i]._rng_fn) for i in range(cfg.num_envs)],
                dtype=np.int64,
            )
        else:
            actions = learner.act(obs, explore=True)
            if cfg.algo == "dqn" and cfg.imitate_frac > 0:
                remain = max(0.1, 1.0 - learner.env_steps / max(1, cfg.steps))
                p = cfg.imitate_frac * remain
                for i in range(cfg.num_envs):
                    if rng.random() < p:
                        actions[i] = planners[i].act(vec.envs[i].state, vec.envs[i]._rng_fn)

        next_obs, rewards, dones, _infos = vec.step(actions, cfg.seed)
        learner.observe(obs, actions, rewards, next_obs, dones)
        updated = learner.update()
        if updated:
            last_metrics = updated
        obs = next_obs
        for i, done in enumerate(dones):
            if done:
                planners[i] = HeuristicPlanner()

        if (
            cfg.algo == "bc_ppo"
            and phase == "bc"
            and learner.env_steps >= cfg.bc_steps
            and isinstance(learner, BCLearner)
        ):
            print(f"[tetris-rl] BC → PPO at env_steps={learner.env_steps}", flush=True)
            learner = learner.to_ppo()
            phase = "ppo"

        env_steps = learner.env_steps
        if env_steps >= next_log:
            elapsed = time.time() - t0
            sps = env_steps / max(1e-6, elapsed)
            print(
                f"[train] steps={env_steps} phase={phase} sps={sps:.0f} {last_metrics}",
                flush=True,
            )
            next_log += cfg.log_every

        do_eval = env_steps >= next_eval or env_steps >= cfg.steps
        if do_eval and env_steps > 0:
            learner_net = getattr(learner, "policy", None) or getattr(learner, "net", None)
            if learner_net is not None:
                learner_net.eval()
            last_eval = evaluate_act(
                _act_fn(learner),
                eval_seeds,
                max_steps=cfg.eval_max_steps,
                gravity_min=cfg.gravity_min,
                gravity_max=cfg.gravity_max,
            )
            if learner_net is not None:
                learner_net.train()
            record = {
                "step": env_steps,
                "phase": phase,
                "elapsed_sec": time.time() - t0,
                "sps": env_steps / max(1e-6, time.time() - t0),
                **last_metrics,
                **last_eval,
            }
            history.append(record)
            with metrics_path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(record) + "\n")
            print(json.dumps(record, ensure_ascii=False), flush=True)
            _save(ckpt_dir / f"step_{env_steps}.pt", cfg, learner, {"metrics": last_eval})
            _save(ckpt_dir / "latest.pt", cfg, learner, {"metrics": last_eval})
            next_eval += cfg.eval_every
            next_ckpt = env_steps + cfg.ckpt_every

        if env_steps >= next_ckpt:
            _save(ckpt_dir / "latest.pt", cfg, learner, {"metrics": last_eval})
            next_ckpt += cfg.ckpt_every

    _save(ckpt_dir / "latest.pt", cfg, learner, {"metrics": last_eval})
    summary = {
        "algo": cfg.algo,
        "run_dir": str(run_dir),
        "env_steps": learner.env_steps,
        "final_eval": last_eval,
        "baselines": baselines,
        "history": history,
        "stopped": stop,
        "pid": os.getpid(),
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(f"[tetris-rl] done steps={learner.env_steps} dir={run_dir}", flush=True)
    if last_eval:
        print(
            f"[tetris-rl] final mean_lines={last_eval.get('mean_lines')} "
            f"(heuristic={baselines.get('heuristic', {}).get('mean_lines')}, "
            f"random={baselines.get('random', {}).get('mean_lines')})",
            flush=True,
        )
    return summary


def sweep(suite_path: Path) -> list[dict[str, Any]]:
    payload = json.loads(suite_path.read_text(encoding="utf-8"))
    runs = payload.get("runs")
    if not isinstance(runs, list) or not runs:
        raise ValueError(f"{suite_path} needs a non-empty 'runs' list")
    defaults = {k: v for k, v in payload.items() if k != "runs"}
    summaries = []
    for i, item in enumerate(runs):
        merged = {**defaults, **item}
        cfg = TrainConfig.from_dict(merged)
        print(f"[sweep] {i + 1}/{len(runs)} algo={cfg.algo} name={cfg.run_name or cfg.algo}", flush=True)
        summaries.append(train(cfg))
    run_root = Path(payload.get("run_dir") or "runs")
    run_root.mkdir(parents=True, exist_ok=True)
    (run_root / "sweep_results.json").write_text(json.dumps(summaries, indent=2), encoding="utf-8")
    print(f"[sweep] wrote {run_root / 'sweep_results.json'}", flush=True)
    return summaries
