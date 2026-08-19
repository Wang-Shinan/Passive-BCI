"""Placement heuristic that emits realtime actions. Search lives in search.py."""

from __future__ import annotations

from concurrent.futures import ProcessPoolExecutor

from .engine import GameState
from .search import (
    DEFAULT_BEAM,
    DEFAULT_DEPTH,
    DEFAULT_MAX_NODES,
    best_placement_actions,
    resolve_search_workers,
)


class HeuristicPlanner:
    def __init__(
        self,
        depth: int = 1,
        mc_samples: int = 0,
        mc_horizon: int = 3,
        beam: int = DEFAULT_BEAM,
        max_nodes: int = DEFAULT_MAX_NODES,
        workers: int = 0,
        device: str = "none",
    ):
        self.depth = depth
        self.mc_samples = mc_samples
        self.mc_horizon = mc_horizon
        self.beam = beam
        self.max_nodes = max_nodes
        self.device = device
        self.workers = resolve_search_workers(workers)
        self._pool: ProcessPoolExecutor | None = None
        if self.workers > 1:
            self._pool = ProcessPoolExecutor(max_workers=self.workers)
        self._plan: list[str] = []
        self._piece_id: tuple | None = None

    def _piece_key(self, state: GameState) -> tuple | None:
        p = state.piece
        if not p:
            return None
        # Commit one placement per piece. Including y/x made gravity replan
        # every 100ms and flip targets before hardDrop.
        return (p.type, state.lines, state.next, tuple(state.bag))

    def act(self, state: GameState, rng) -> int:
        from .engine import RL_ACTION_NAMES

        key = self._piece_key(state)
        if key != self._piece_id or not self._plan:
            self._plan = best_placement_actions(
                state,
                rng,
                depth=self.depth,
                mc_samples=self.mc_samples,
                mc_horizon=self.mc_horizon,
                beam=self.beam,
                max_nodes=self.max_nodes,
                workers=self.workers,
                pool=self._pool,
                device=self.device,
            )
            self._piece_id = key

        if not self._plan:
            return RL_ACTION_NAMES.index("noop")
        action = self._plan.pop(0)
        if action == "hardDrop":
            self._piece_id = None
            self._plan = []
        return RL_ACTION_NAMES.index(action)

    def close(self) -> None:
        if self._pool is not None:
            self._pool.shutdown(wait=True)
            self._pool = None

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass


def lookahead_planner(
    depth: int = DEFAULT_DEPTH,
    beam: int = DEFAULT_BEAM,
    max_nodes: int = DEFAULT_MAX_NODES,
    workers: int = -1,
    mc_samples: int = 0,
    mc_horizon: int = 3,
    device: str = "auto",
) -> HeuristicPlanner:
    """Teacher for offline collect: several pieces ahead, parallel locks."""
    return HeuristicPlanner(
        depth=depth,
        beam=beam,
        max_nodes=max_nodes,
        workers=workers,
        mc_samples=mc_samples,
        mc_horizon=mc_horizon,
        device=device,
    )
