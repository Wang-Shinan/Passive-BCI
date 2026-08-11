"""Training loop: oracle feedback → Q-learning / TAMER."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Literal, Optional, Tuple

import numpy as np

from .graph import all_dist_to_goal, generate_free_graph, generate_grid, pick_start
from .learners import (
    QParams,
    TamerParams,
    ValueTable,
    best_action,
    epsilon_greedy,
    td_update,
    tamer_update,
)
from .oracle import corrupt_rating, make_feedback_fn, oracle_rating, random_rating

Algo = Literal["qlearning", "tamer"]
RewardMode = Literal["oracle", "random", "random_keep_goal"]


@dataclass
class TrainConfig:
    algo: Algo = "tamer"
    episodes: int = 200
    max_steps: int = 60
    epsilon_end: float = 0.05
    epsilon_decay_episodes: int = 150
    graph_mode: str = "grid"
    grid_cols: int = 6
    grid_rows: int = 5
    node_count: int = 24
    density: float = 1.8
    seed: int = 0
    sigma: float = 0.0
    flip_prob: float = 0.0
    miss_prob: float = 0.0
    # oracle | random | random_keep_goal — see _clean_reward
    reward_mode: RewardMode = "oracle"
    q: Optional[QParams] = None
    tamer: Optional[TamerParams] = None


@dataclass
class EpisodeLog:
    episode: int
    steps: int
    shortest: int
    reached: bool
    optimal_ratio: float


def _epsilon_schedule(ep: int, cfg: TrainConfig, base_eps: float) -> float:
    if cfg.epsilon_decay_episodes <= 0:
        return base_eps
    t = min(1.0, ep / cfg.epsilon_decay_episodes)
    return float(base_eps * (1.0 - t) + cfg.epsilon_end * t)


def policy_optimal_ratio(table: ValueTable, graph, dist: np.ndarray, rng: np.random.Generator) -> float:
    good = 0
    total = 0
    for s in range(graph.n):
        if s == graph.goal or dist[s] >= 10**9:
            continue
        a = best_action(table, graph, s, rng)
        if a is None:
            continue
        total += 1
        if dist[a] < dist[s]:
            good += 1
    return good / total if total else 0.0


def _clean_reward(
    dist: np.ndarray,
    state: int,
    action: int,
    done: bool,
    cfg: TrainConfig,
    rng: np.random.Generator,
) -> float:
    """Pre-noise rating under the configured reward mode."""
    if cfg.reward_mode == "random":
        return random_rating(rng)
    if cfg.reward_mode == "random_keep_goal":
        if done:
            return 1.0
        return random_rating(rng)
    # oracle (default): progress label; goal auto +1
    if done:
        return 1.0
    return oracle_rating(dist, state, action)


def _observe(
    clean: float,
    cfg: TrainConfig,
    rng: np.random.Generator,
) -> Optional[float]:
    """Decoder observation: miss → None; else optional noise."""
    if cfg.miss_prob > 0 and rng.random() < cfg.miss_prob:
        return None
    if cfg.sigma <= 0 and cfg.flip_prob <= 0:
        return clean
    return corrupt_rating(clean, cfg.sigma, cfg.flip_prob, rng)


def run_training(cfg: TrainConfig) -> Dict[str, Any]:
    rng = np.random.default_rng(cfg.seed)
    obs_rng = np.random.default_rng(cfg.seed + 91)

    if cfg.graph_mode == "grid":
        graph = generate_grid(cfg.grid_cols, cfg.grid_rows, seed=cfg.seed)
    else:
        graph = generate_free_graph(cfg.node_count, cfg.density, seed=cfg.seed)

    dist = all_dist_to_goal(graph)
    # feedback fn used only for its seeded channel consistency on non-terminal;
    # we use oracle_rating + _observe directly for clarity.
    _ = make_feedback_fn(graph, sigma=0.0, flip_prob=0.0, miss_prob=0.0, seed=cfg.seed)

    q_params = cfg.q or QParams()
    tamer_params = cfg.tamer or TamerParams()
    table = ValueTable()
    logs: List[EpisodeLog] = []
    base_eps = tamer_params.epsilon if cfg.algo == "tamer" else q_params.epsilon

    for ep in range(1, cfg.episodes + 1):
        start = pick_start(graph, dist, rng)
        shortest = int(dist[start])
        state = start
        steps = 0
        reached = False
        trace: List[Tuple[int, int]] = []
        opt_hits = 0
        opt_total = 0
        eps = _epsilon_schedule(ep - 1, cfg, base_eps)

        while steps < cfg.max_steps:
            action = epsilon_greedy(table, graph, state, eps, rng)
            if action is None:
                break

            clean = oracle_rating(dist, state, action)
            if clean > 0:
                opt_hits += 1
            opt_total += 1

            next_state = action
            done = next_state == graph.goal
            steps += 1
            trace.append((state, action))

            clean_obs = _clean_reward(dist, state, action, done, cfg, obs_rng)
            obs = _observe(clean_obs, cfg, obs_rng)
            if obs is not None:
                if cfg.algo == "tamer":
                    tamer_update(table, obs, trace, tamer_params)
                else:
                    td_update(table, graph, state, action, next_state, obs, q_params, done)
            # else: decoder miss / timeout → do not update (matches web app)

            state = next_state
            if done:
                reached = True
                break

        logs.append(
            EpisodeLog(
                episode=ep,
                steps=steps,
                shortest=shortest,
                reached=reached,
                optimal_ratio=opt_hits / opt_total if opt_total else 0.0,
            )
        )

    final_opt = policy_optimal_ratio(table, graph, dist, rng)
    last_n = logs[-20:] if len(logs) >= 20 else logs
    reached_last = [L for L in last_n if L.reached]
    mean_excess = float(
        np.mean([L.steps - L.shortest for L in reached_last]) if reached_last else np.nan
    )
    success_last = float(np.mean([1.0 if L.reached else 0.0 for L in last_n]))

    streak_need = 5
    streak = 0
    converge_ep: Optional[int] = None
    for L in logs:
        if L.reached and L.steps <= L.shortest + 1:
            streak += 1
            if streak >= streak_need:
                converge_ep = L.episode
                break
        else:
            streak = 0

    return {
        "config": {
            **{k: v for k, v in asdict(cfg).items() if k not in ("q", "tamer")},
            "q": asdict(q_params),
            "tamer": asdict(tamer_params),
        },
        "graph": {"n": graph.n, "goal": graph.goal, "mode": graph.mode},
        "episodes": [asdict(L) for L in logs],
        "summary": {
            "final_optimal_action_ratio": final_opt,
            "last20_success": success_last,
            "last20_mean_excess_steps": mean_excess,
            "converge_episode": converge_ep,
            "table_size": len(table.values),
        },
    }
