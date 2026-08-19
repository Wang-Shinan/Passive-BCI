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

from .algos.afterstate import AfterstateLearner
from .algos.bc import BCLearner
from .algos.dqn import DQNLearner
from .algos.iql import IQLLearner
from .algos.ppo import PPOLearner
from .algos.pqn import PQNLearner
from .config import TrainConfig, resolve_device
from .engine import RL_DECISION_DT_SEC
from .evaluate import evaluate_act, heuristic_baseline, random_baseline
from .model import count_parameters
from .vec_env import make_vec_env


def make_learner(cfg: TrainConfig, device: torch.device, obs_shape: tuple[int, ...]):
    if cfg.algo == "dqn":
        return DQNLearner(cfg, device, obs_shape)
    if cfg.algo == "ppo":
        return PPOLearner(cfg, device, cfg.num_envs, obs_shape)
    if cfg.algo == "pqn":
        return PQNLearner(cfg, device, cfg.num_envs, obs_shape)
    if cfg.algo == "iql":
        return IQLLearner(cfg, device, obs_shape)
    if cfg.algo in ("bc", "bc_ppo", "dagger"):
        return BCLearner(cfg, device, obs_shape)
    if cfg.algo in ("afterstate", "afterstate_ppo"):
        return AfterstateLearner(cfg, device)
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


def train_afterstate(cfg: TrainConfig) -> dict[str, Any]:
    from .afterstate import enumerate_placements, pack_boards, pack_placements, play_plan
    from .encode import encode_observation
    from .env import TetrisEnv
    from .evaluate import evaluate_afterstate

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    run_name = cfg.run_name or f"{cfg.algo}_{stamp}"
    run_dir = Path(cfg.run_dir) / run_name
    ckpt_dir = run_dir / "ckpt"
    run_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(cfg.to_dict(), indent=2), encoding="utf-8")
    metrics_path = run_dir / "metrics.jsonl"

    device = torch.device(resolve_device(cfg.device))
    learner = AfterstateLearner(cfg, device)
    n_params = count_parameters(learner.net)
    enc = "cnn" if learner.use_cnn else "mlp"
    print(
        f"[tetris-rl] algo={cfg.algo} encoder={enc} steps={cfg.steps} envs={cfg.num_envs} "
        f"width={cfg.width} depth={cfg.depth} hidden={cfg.hidden} "
        f"params={n_params / 1e6:.1f}M {_gpu_banner(device)}",
        flush=True,
    )
    print(f"[tetris-rl] run_dir={run_dir.resolve()}", flush=True)
    if cfg.resume:
        resume_path = Path(cfg.resume)
        if cfg.resume == "auto":
            resume_path = ckpt_dir / "latest.pt"
        if resume_path.exists():
            payload = torch.load(resume_path, map_location=device, weights_only=False)
            policy_only = learner.ppo_mode and payload.get("kind") != "afterstate_ppo"
            learner.load(payload, policy_only=policy_only)
            print(
                f"[tetris-rl] resumed {resume_path} kind={payload.get('kind')} "
                f"policy_only={policy_only} env_steps={learner.env_steps}",
                flush=True,
            )
        else:
            print(f"[tetris-rl] resume path missing: {resume_path}", flush=True)

    envs = [
        TetrisEnv(
            gravity_min=cfg.gravity_min,
            gravity_max=cfg.gravity_max,
            seed=cfg.seed + i,
            survival_bonus=cfg.survival_bonus,
        )
        for i in range(max(1, cfg.num_envs))
    ]
    for i, env in enumerate(envs):
        env.reset(seed=cfg.seed + i)

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

    stop = False

    def _handle(signum, _frame):
        nonlocal stop
        stop = True
        print(f"[tetris-rl] signal {signum}, will save and exit", flush=True)

    signal.signal(signal.SIGINT, _handle)
    signal.signal(signal.SIGTERM, _handle)

    t0 = time.time()
    last_eval: dict[str, Any] = {}
    history: list[dict[str, Any]] = []
    last_metrics: dict[str, float] = {}
    next_log = cfg.log_every
    next_eval = cfg.eval_every
    rng = Random(cfg.seed + 1)

    def _placements_for(env, i: int):
        while True:
            if env.state.game_over or not env.state.piece:
                env.reset(seed=cfg.seed + i + rng.randrange(1_000_000))
            placements = enumerate_placements(env.state)
            if placements:
                return placements
            env.reset(seed=cfg.seed + i + rng.randrange(1_000_000))

    while learner.env_steps < cfg.steps and not stop:
        for i, env in enumerate(envs):
            placements = _placements_for(env, i)
            feats, mask, teacher = pack_placements(placements)
            boards = pack_boards(placements) if learner.use_cnn else None
            if learner.ppo_mode:
                cur = encode_observation(env.state, 0.5)
                use_teacher = rng.random() < max(0.0, cfg.imitate_frac)
                idx, logp, value = learner.act_dist(
                    feats,
                    mask,
                    boards,
                    cur=cur,
                    sample=not use_teacher,
                    action=int(teacher) if use_teacher else None,
                )
                idx = min(idx, len(placements) - 1)
                done, _, rew = play_plan(env, placements[idx].plan)
                learner.observe_ppo(
                    i, feats, mask, idx, logp, value, rew, done, boards=boards, cur=cur
                )
                if done:
                    env.reset(seed=cfg.seed + i + rng.randrange(1_000_000))
            else:
                learner.remember(feats, mask, int(teacher), boards=boards)
                idx = int(teacher) if rng.random() < max(0.0, cfg.imitate_frac) else learner.act(
                    feats, mask, explore=True, boards=boards
                )
                idx = min(idx, len(placements) - 1)
                done, _, _ = play_plan(env, placements[idx].plan)
                if done:
                    env.reset(seed=cfg.seed + i + rng.randrange(1_000_000))
        if learner.ppo_mode:
            next_v = None
            if learner.rollout_ready():
                next_v = np.zeros(len(envs), dtype=np.float32)
                for i, env in enumerate(envs):
                    placements = _placements_for(env, i)
                    feats, mask, _ = pack_placements(placements)
                    boards = pack_boards(placements) if learner.use_cnn else None
                    cur = encode_observation(env.state, 0.5)
                    next_v[i] = learner.value(feats, mask, boards, cur=cur)
            updated = learner.update(next_v)
        else:
            updated = learner.update()
        if updated:
            last_metrics = updated

        env_steps = learner.env_steps
        if env_steps >= next_log:
            elapsed = time.time() - t0
            print(
                f"[train] placements={env_steps} sps={env_steps / max(1e-6, elapsed):.0f} {last_metrics}",
                flush=True,
            )
            next_log += cfg.log_every
        if env_steps >= next_eval or env_steps >= cfg.steps:
            learner.net.eval()
            last_eval = evaluate_afterstate(
                learner, eval_seeds, max_pieces=max(80, cfg.eval_max_steps // 4)
            )
            learner.net.train()
            record = {
                "step": env_steps,
                "phase": cfg.algo,
                "elapsed_sec": time.time() - t0,
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

    _save(ckpt_dir / "latest.pt", cfg, learner, {"metrics": last_eval})
    summary = {
        "algo": cfg.algo,
        "run_dir": str(run_dir),
        "env_steps": learner.env_steps,
        "final_eval": last_eval,
        "baselines": baselines,
        "history": history,
        "stopped": stop,
        "params": n_params,
    }
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(
        f"[tetris-rl] done placements={learner.env_steps} mean_lines={last_eval.get('mean_lines')} "
        f"dir={run_dir}",
        flush=True,
    )
    return summary


def train(cfg: TrainConfig) -> dict[str, Any]:
    if cfg.algo in ("afterstate", "afterstate_ppo"):
        return train_afterstate(cfg)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    run_name = cfg.run_name or f"{cfg.algo}_{stamp}"
    run_dir = Path(cfg.run_dir) / run_name
    ckpt_dir = run_dir / "ckpt"
    run_dir.mkdir(parents=True, exist_ok=True)
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "config.json").write_text(json.dumps(cfg.to_dict(), indent=2), encoding="utf-8")
    metrics_path = run_dir / "metrics.jsonl"

    vec = make_vec_env(
        cfg.num_envs,
        cfg.seed,
        gravity_min=cfg.gravity_min,
        gravity_max=cfg.gravity_max,
        frame_stack=cfg.frame_stack,
        frame_stride=cfg.frame_stride,
        vec_backend=cfg.vec_backend,
        num_workers=cfg.num_workers,
        survival_bonus=cfg.survival_bonus,
    )
    device = torch.device(resolve_device(cfg.device))
    if device.type == "cuda":
        torch.backends.cudnn.benchmark = True
    learner = make_learner(cfg, device, vec.obs_shape)
    net = getattr(learner, "policy", None) or getattr(learner, "net", None)
    n_params = count_parameters(net) if net is not None else 0
    ctx_sec = max(1, cfg.frame_stack) * max(1, cfg.frame_stride) * RL_DECISION_DT_SEC
    print(
        f"[tetris-rl] algo={cfg.algo} steps={cfg.steps} envs={cfg.num_envs} "
        f"stack={cfg.frame_stack} stride={cfg.frame_stride} context={ctx_sec:.1f}s "
        f"obs={tuple(vec.obs_shape)} "
        f"width={cfg.width} depth={cfg.depth} hidden={cfg.hidden} "
        f"params={n_params / 1e6:.1f}M backend={cfg.vec_backend} {_gpu_banner(device)}",
        flush=True,
    )
    print(f"[tetris-rl] run_dir={run_dir.resolve()}", flush=True)
    if cfg.resume:
        resume_path = Path(cfg.resume)
        if cfg.resume == "auto":
            resume_path = ckpt_dir / "latest.pt"
        if resume_path.exists():
            payload = torch.load(resume_path, map_location=device, weights_only=False)
            learner.load(payload)
            print(f"[tetris-rl] resumed {resume_path} at env_steps={learner.env_steps}", flush=True)

    obs = vec.reset(cfg.seed)
    rng = Random(cfg.seed + 1)
    if cfg.algo in ("bc", "bc_ppo"):
        phase = "bc"
    else:
        phase = cfg.algo
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
        if phase == "bc" or cfg.algo == "iql":
            actions = vec.heuristic_act()
            labels = actions
        elif cfg.algo == "dagger":
            student = learner.act(obs, explore=True)
            teacher = vec.heuristic_act()
            frac = min(1.0, learner.env_steps / max(1, cfg.steps))
            beta = cfg.dagger_beta_start + (cfg.dagger_beta_end - cfg.dagger_beta_start) * frac
            mask = np.fromiter(
                (rng.random() < beta for _ in range(cfg.num_envs)),
                dtype=np.bool_,
                count=cfg.num_envs,
            )
            actions = np.where(mask, teacher, student)
            labels = teacher
        else:
            actions = learner.act(obs, explore=True)
            if cfg.algo in ("dqn", "pqn") and cfg.imitate_frac > 0:
                remain = max(0.1, 1.0 - learner.env_steps / max(1, cfg.steps))
                p = cfg.imitate_frac * remain
                mask = np.fromiter(
                    (rng.random() < p for _ in range(cfg.num_envs)),
                    dtype=np.bool_,
                    count=cfg.num_envs,
                )
                if mask.any():
                    heur = vec.heuristic_act(mask)
                    actions = np.where(mask, heur, actions)
            labels = actions

        next_obs, rewards, dones, _infos = vec.step(actions, cfg.seed)
        learner.observe(obs, labels, rewards, next_obs, dones)
        updated = learner.update()
        if updated:
            last_metrics = updated
        obs = next_obs

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
                frame_stack=cfg.frame_stack,
                frame_stride=cfg.frame_stride,
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
    close = getattr(vec, "close", None)
    if close is not None:
        close()
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
