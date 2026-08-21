"""Vector of TetrisEnv: sync, subprocess, and frame-stack wrappers."""

from __future__ import annotations

import os
from multiprocessing.connection import Connection
from typing import Any

import numpy as np

from .encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from .env import TetrisEnv
from .heuristic import HeuristicPlanner

ObsShape = tuple[int, int, int]


def _split_counts(n: int, workers: int) -> list[int]:
    workers = max(1, min(workers, n))
    base, rem = divmod(n, workers)
    return [base + (1 if i < rem else 0) for i in range(workers)]


def resolve_workers(num_envs: int, num_workers: int) -> int:
    if num_workers > 0:
        return max(1, min(num_workers, num_envs))
    try:
        cpus = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        cpus = os.cpu_count() or 8
    cap = max(1, min(32, max(1, cpus // 2), num_envs))
    return cap


def _cuda_already_on() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_initialized())
    except Exception:
        return False


class SyncVectorEnv:
    def __init__(
        self,
        num_envs: int,
        seed: int,
        gravity_min: float = 1.0,
        gravity_max: float = 6.0,
        survival_bonus: float = 0.05,
        planner_depth: int = 1,
        planner_mc_samples: int = 0,
        planner_mc_horizon: int = 3,
    ):
        if num_envs < 1:
            raise ValueError("num_envs must be >= 1")
        self.num_envs = num_envs
        self._planner_kw = {
            "depth": planner_depth,
            "mc_samples": planner_mc_samples,
            "mc_horizon": planner_mc_horizon,
        }
        self.envs = [
            TetrisEnv(
                gravity_min=gravity_min,
                gravity_max=gravity_max,
                seed=seed + i,
                survival_bonus=survival_bonus,
            )
            for i in range(num_envs)
        ]
        self.planners = [HeuristicPlanner(**self._planner_kw) for _ in range(num_envs)]
        self._episode = np.zeros(num_envs, dtype=np.int64)

    @property
    def obs_shape(self) -> ObsShape:
        return (RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)

    def reset(self, seed: int) -> np.ndarray:
        obs = []
        for i, env in enumerate(self.envs):
            o, _ = env.reset(seed=seed + i + int(self._episode[i]) * 1009)
            obs.append(o)
        return np.stack(obs, axis=0)

    def step(self, actions: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
        next_obs = np.empty((self.num_envs, *self.obs_shape), dtype=np.float32)
        rewards = np.empty(self.num_envs, dtype=np.float32)
        dones = np.zeros(self.num_envs, dtype=np.bool_)
        infos: list[dict] = []
        for i, env in enumerate(self.envs):
            o, r, terminated, truncated, info = env.step(int(actions[i]))
            done = bool(terminated or truncated)
            if done:
                self._episode[i] += 1
                self.planners[i] = HeuristicPlanner(**self._planner_kw)
                o, _ = env.reset(seed=seed + i + int(self._episode[i]) * 1009)
            next_obs[i] = o
            rewards[i] = r
            dones[i] = done
            infos.append(info)
        return next_obs, rewards, dones, infos

    def heuristic_act(self, mask: np.ndarray | None = None) -> np.ndarray:
        out = np.zeros(self.num_envs, dtype=np.int64)
        indices = range(self.num_envs) if mask is None else np.flatnonzero(mask)
        for i in indices:
            out[i] = self.planners[i].act(self.envs[i].state, self.envs[i]._rng_fn)
        return out

    def close(self) -> None:
        return


def _subproc_worker(
    remote: Connection,
    parent: Connection,
    n_local: int,
    seed0: int,
    gravity_min: float,
    gravity_max: float,
    survival_bonus: float,
) -> None:
    parent.close()
    envs = [
        TetrisEnv(
            gravity_min=gravity_min,
            gravity_max=gravity_max,
            seed=seed0 + i,
            survival_bonus=survival_bonus,
        )
        for i in range(n_local)
    ]
    planners = [HeuristicPlanner() for _ in range(n_local)]
    episode = np.zeros(n_local, dtype=np.int64)
    try:
        while True:
            cmd, data = remote.recv()
            if cmd == "reset":
                seed = int(data)
                obs = np.empty((n_local, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS), dtype=np.float32)
                for i, env in enumerate(envs):
                    o, _ = env.reset(seed=seed + i + int(episode[i]) * 1009)
                    obs[i] = o
                remote.send(obs)
            elif cmd == "step":
                actions, seed = data
                next_obs = np.empty((n_local, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS), dtype=np.float32)
                rewards = np.empty(n_local, dtype=np.float32)
                dones = np.zeros(n_local, dtype=np.bool_)
                infos: list[dict] = []
                for i, env in enumerate(envs):
                    o, r, terminated, truncated, info = env.step(int(actions[i]))
                    done = bool(terminated or truncated)
                    if done:
                        episode[i] += 1
                        planners[i] = HeuristicPlanner()
                        o, _ = env.reset(seed=int(seed) + i + int(episode[i]) * 1009)
                    next_obs[i] = o
                    rewards[i] = r
                    dones[i] = done
                    infos.append(info)
                remote.send((next_obs, rewards, dones, infos))
            elif cmd == "heuristic":
                mask = data
                out = np.zeros(n_local, dtype=np.int64)
                indices = range(n_local) if mask is None else np.flatnonzero(mask)
                for i in indices:
                    out[i] = planners[i].act(envs[i].state, envs[i]._rng_fn)
                remote.send(out)
            elif cmd == "close":
                break
            else:
                raise RuntimeError(f"unknown vec cmd {cmd}")
    finally:
        remote.close()


class SubprocVectorEnv:
    def __init__(
        self,
        num_envs: int,
        seed: int,
        gravity_min: float = 1.0,
        gravity_max: float = 6.0,
        num_workers: int = 0,
        survival_bonus: float = 0.05,
    ):
        import multiprocessing as mp

        if num_envs < 1:
            raise ValueError("num_envs must be >= 1")
        self.num_envs = num_envs
        sizes = _split_counts(num_envs, resolve_workers(num_envs, num_workers))
        self._sizes = sizes
        ctx = mp.get_context("spawn" if _cuda_already_on() else "fork")
        self._ps: list[Any] = []
        self._remotes: list[Connection] = []
        offset = 0
        for size in sizes:
            remote, local = ctx.Pipe()
            proc = ctx.Process(
                target=_subproc_worker,
                args=(local, remote, size, seed + offset, gravity_min, gravity_max, survival_bonus),
                daemon=True,
            )
            proc.start()
            local.close()
            self._ps.append(proc)
            self._remotes.append(remote)
            offset += size
        self.closed = False

    @property
    def obs_shape(self) -> ObsShape:
        return (RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)

    def reset(self, seed: int) -> np.ndarray:
        chunks = []
        offset = 0
        for remote, size in zip(self._remotes, self._sizes):
            remote.send(("reset", seed + offset))
            offset += size
        for remote in self._remotes:
            chunks.append(remote.recv())
        return np.concatenate(chunks, axis=0)

    def step(self, actions: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
        offset = 0
        for remote, size in zip(self._remotes, self._sizes):
            remote.send(("step", (actions[offset : offset + size], seed + offset)))
            offset += size
        obs_parts = []
        rew_parts = []
        done_parts = []
        infos: list[dict] = []
        for remote in self._remotes:
            o, r, d, info = remote.recv()
            obs_parts.append(o)
            rew_parts.append(r)
            done_parts.append(d)
            infos.extend(info)
        return (
            np.concatenate(obs_parts, axis=0),
            np.concatenate(rew_parts, axis=0),
            np.concatenate(done_parts, axis=0),
            infos,
        )

    def heuristic_act(self, mask: np.ndarray | None = None) -> np.ndarray:
        offset = 0
        for remote, size in zip(self._remotes, self._sizes):
            local_mask = None if mask is None else mask[offset : offset + size]
            remote.send(("heuristic", local_mask))
            offset += size
        parts = [remote.recv() for remote in self._remotes]
        return np.concatenate(parts, axis=0)

    def close(self) -> None:
        if self.closed:
            return
        for remote in self._remotes:
            try:
                remote.send(("close", None))
            except (BrokenPipeError, OSError, EOFError):
                pass
        for proc in self._ps:
            proc.join(timeout=5)
            if proc.is_alive():
                proc.terminate()
        self.closed = True

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


class FrameStack:
    """Stack K observations. With stride>1 the oldest slots advance every N steps,
    while the newest slot is always the current frame."""

    def __init__(self, vec: SyncVectorEnv | SubprocVectorEnv, k: int, stride: int = 1):
        self.vec = vec
        self.k = max(1, int(k))
        self.stride = max(1, int(stride))
        self.num_envs = vec.num_envs
        c, h, w = vec.obs_shape
        self._c, self._h, self._w = c, h, w
        self._buf = np.zeros((self.num_envs, self.k, c, h, w), dtype=np.float32)
        self._count = np.zeros(self.num_envs, dtype=np.int32)

    @property
    def obs_shape(self) -> ObsShape:
        return (self._c * self.k, self._h, self._w)

    @property
    def envs(self):
        return getattr(self.vec, "envs")

    def _pack(self) -> np.ndarray:
        return self._buf.reshape(self.num_envs, self._c * self.k, self._h, self._w)

    def reset(self, seed: int) -> np.ndarray:
        obs = self.vec.reset(seed)
        self._buf[:] = obs[:, None]
        self._count[:] = 0
        return self._pack()

    def step(self, actions: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
        obs, rewards, dones, infos = self.vec.step(actions, seed)
        self._count += 1
        if self.k > 1:
            shift = self._count % self.stride == 0
            if shift.any():
                self._buf[shift, :-1] = self._buf[shift, 1:]
        self._buf[:, -1] = obs
        if dones.any():
            self._buf[dones] = obs[dones, None]
            self._count[dones] = 0
        return self._pack(), rewards, dones, infos

    def heuristic_act(self, mask: np.ndarray | None = None) -> np.ndarray:
        return self.vec.heuristic_act(mask)

    def close(self) -> None:
        close = getattr(self.vec, "close", None)
        if close is not None:
            close()


def make_vec_env(
    num_envs: int,
    seed: int,
    gravity_min: float = 1.0,
    gravity_max: float = 6.0,
    frame_stack: int = 1,
    frame_stride: int = 1,
    vec_backend: str = "sync",
    num_workers: int = 0,
    survival_bonus: float = 0.05,
) -> SyncVectorEnv | SubprocVectorEnv | FrameStack:
    if vec_backend == "subproc":
        inner: SyncVectorEnv | SubprocVectorEnv = SubprocVectorEnv(
            num_envs,
            seed,
            gravity_min=gravity_min,
            gravity_max=gravity_max,
            num_workers=num_workers,
            survival_bonus=survival_bonus,
        )
    else:
        inner = SyncVectorEnv(
            num_envs,
            seed,
            gravity_min=gravity_min,
            gravity_max=gravity_max,
            survival_bonus=survival_bonus,
        )
    if frame_stack > 1:
        return FrameStack(inner, frame_stack, stride=frame_stride)
    return inner
