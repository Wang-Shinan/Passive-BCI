"""Behavioral cloning and PPO over placement afterstates."""

from __future__ import annotations

from typing import Any

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
import torch.optim as optim
from torch.distributions import Categorical

from ..afterstate import AFTERSTATE_DIM, MAX_CANDIDATES
from ..config import TrainConfig
from ..encode import RL_OBS_CHANNELS, RL_OBS_COLS, RL_OBS_ROWS
from ..model import AfterstateCNN, AfterstateNet, feature_dim


class AfterstateLearner:
    def __init__(self, cfg: TrainConfig, device: torch.device):
        self.cfg = cfg
        self.device = device
        self.ppo_mode = cfg.algo == "afterstate_ppo"
        self.use_cnn = str(getattr(cfg, "afterstate_encoder", "mlp")).lower() == "cnn"
        if self.use_cnn:
            self.net = AfterstateCNN(
                width=cfg.width, hidden=cfg.hidden, depth=cfg.depth, in_channels=RL_OBS_CHANNELS
            ).to(device)
        else:
            hidden = int(cfg.hidden) if cfg.hidden <= 256 else 64
            self.net = AfterstateNet(
                AFTERSTATE_DIM, hidden=hidden, depth=max(1, min(4, cfg.depth))
            ).to(device)
        self.critic = self._make_critic() if self.ppo_mode else None
        self.optimizer = optim.Adam(self._param_groups(), lr=cfg.lr)
        self.env_steps = 0
        self.updates = 0
        self._use_amp = cfg.precision == "bf16" and device.type == "cuda"
        self.num_envs = max(1, cfg.num_envs)
        if self.ppo_mode:
            self._reset_rollout()
            self.cap = 0
            self.size = 0
            self.idx = 0
            self.feats = None
            self.mask = None
            self.target = None
            self.boards = None
        else:
            cap = max(cfg.bc_batch * 8, 1024 if self.use_cnn else 8192)
            self.feats = np.zeros((cap, MAX_CANDIDATES, AFTERSTATE_DIM), dtype=np.float32)
            self.mask = np.zeros((cap, MAX_CANDIDATES), dtype=np.bool_)
            self.target = np.zeros(cap, dtype=np.int64)
            self.boards = None
            if self.use_cnn:
                self.boards = np.zeros(
                    (cap, MAX_CANDIDATES, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS),
                    dtype=np.float16,
                )
            self.cap = cap
            self.size = 0
            self.idx = 0

    def _make_critic(self) -> nn.Module:
        hid = max(32, min(int(self.cfg.hidden), 256))
        in_dim = feature_dim(self.cfg.width) if self.use_cnn else AFTERSTATE_DIM
        return nn.Sequential(nn.Linear(in_dim, hid), nn.ReLU(inplace=True), nn.Linear(hid, 1)).to(self.device)

    def _param_groups(self):
        params = list(self.net.parameters())
        if self.critic is not None:
            params += list(self.critic.parameters())
        return params

    def _reset_rollout(self) -> None:
        t = max(1, self.cfg.rollout_steps)
        n = self.num_envs
        self._i = 0
        self._filled = 0
        self.roll_feats = np.zeros((t, n, MAX_CANDIDATES, AFTERSTATE_DIM), dtype=np.float32)
        self.roll_mask = np.zeros((t, n, MAX_CANDIDATES), dtype=np.bool_)
        self.roll_boards = None
        self.roll_cur = None
        if self.use_cnn:
            self.roll_boards = np.zeros(
                (t, n, MAX_CANDIDATES, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS),
                dtype=np.float16,
            )
            self.roll_cur = np.zeros(
                (t, n, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS),
                dtype=np.float16,
            )
        self.roll_actions = np.zeros((t, n), dtype=np.int64)
        self.roll_logp = np.zeros((t, n), dtype=np.float32)
        self.roll_rewards = np.zeros((t, n), dtype=np.float32)
        self.roll_dones = np.zeros((t, n), dtype=np.float32)
        self.roll_values = np.zeros((t, n), dtype=np.float32)

    def remember(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        target: int,
        boards: np.ndarray | None = None,
    ) -> None:
        if self.ppo_mode:
            return
        self.feats[self.idx] = feats
        self.mask[self.idx] = mask
        self.target[self.idx] = int(target)
        if self.boards is not None and boards is not None:
            self.boards[self.idx] = boards
        self.idx = (self.idx + 1) % self.cap
        self.size = min(self.size + 1, self.cap)
        self.env_steps += 1

    def _forward_logits(self, feats_t: torch.Tensor, mask_t: torch.Tensor, boards_t=None) -> torch.Tensor:
        if self.use_cnn:
            assert boards_t is not None
            b, k = boards_t.shape[:2]
            flat = boards_t.reshape(b * k, *boards_t.shape[2:])
            chunk = 128
            parts = []
            for i in range(0, flat.shape[0], chunk):
                parts.append(self.net(flat[i : i + chunk]))
            logits = torch.cat(parts, dim=0).reshape(b, k)
        else:
            logits = self.net(feats_t)
        return logits.masked_fill(~mask_t, -1e9)

    def _critic_value(
        self,
        feats_t: torch.Tensor,
        mask_t: torch.Tensor,
        cur_t: torch.Tensor | None = None,
        logits: torch.Tensor | None = None,
    ) -> torch.Tensor:
        if self.critic is None:
            assert logits is not None
            probs = torch.softmax(logits.float(), dim=-1)
            return (probs * logits.float()).sum(dim=-1)
        if self.use_cnn:
            assert cur_t is not None
            z = self.net.backbone(cur_t.reshape(-1, *cur_t.shape[-3:])).detach()
            return self.critic(z).squeeze(-1)
        weights = mask_t.float()
        mean = (feats_t * weights.unsqueeze(-1)).sum(dim=1) / weights.sum(dim=1, keepdim=True).clamp_min(1.0)
        return self.critic(mean).squeeze(-1)

    def _batch_tensors(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        boards: np.ndarray | None,
        cur: np.ndarray | None = None,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor | None, torch.Tensor | None]:
        squeeze = feats.ndim == 2
        if squeeze:
            feats = feats[None]
            mask = mask[None]
            if boards is not None:
                boards = boards[None]
            if cur is not None:
                cur = cur[None]
        feats_t = torch.from_numpy(np.asarray(feats, dtype=np.float32)).to(self.device)
        mask_t = torch.from_numpy(np.asarray(mask, dtype=bool)).to(self.device)
        boards_t = None
        cur_t = None
        if boards is not None:
            boards_t = torch.from_numpy(np.asarray(boards, dtype=np.float32)).to(self.device)
        if cur is not None:
            cur_t = torch.from_numpy(np.asarray(cur, dtype=np.float32)).to(self.device)
        return feats_t, mask_t, boards_t, cur_t

    def scores(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        boards: np.ndarray | None = None,
    ) -> np.ndarray:
        squeeze = feats.ndim == 2
        feats_t, mask_t, boards_t, _ = self._batch_tensors(feats, mask, boards)
        with torch.no_grad():
            logits = self._forward_logits(feats_t, mask_t, boards_t)
        out = logits.cpu().numpy()
        return out[0] if squeeze else out

    def act(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        *,
        explore: bool,
        boards: np.ndarray | None = None,
    ) -> int:
        logits = self.scores(feats, mask, boards=boards)
        valid = np.flatnonzero(mask)
        if valid.size == 0:
            return 0
        if explore:
            p = np.exp(logits[valid] - logits[valid].max())
            p = p / max(1e-8, p.sum())
            return int(np.random.choice(valid, p=p))
        return int(valid[np.argmax(logits[valid])])

    def act_dist(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        boards: np.ndarray | None = None,
        cur: np.ndarray | None = None,
        *,
        sample: bool = True,
        action: int | None = None,
    ) -> tuple[int, float, float]:
        feats_t, mask_t, boards_t, cur_t = self._batch_tensors(feats, mask, boards, cur)
        with torch.no_grad():
            logits = self._forward_logits(feats_t, mask_t, boards_t)
            dist = Categorical(logits=logits)
            if action is not None:
                act_t = torch.tensor([int(action)], device=self.device)
            elif sample:
                act_t = dist.sample()
            else:
                act_t = logits.argmax(dim=1)
            logp = dist.log_prob(act_t)
            value = self._critic_value(feats_t, mask_t, cur_t, logits=logits)
        return int(act_t.item()), float(logp.item()), float(value.item())

    def value(
        self,
        feats: np.ndarray,
        mask: np.ndarray,
        boards: np.ndarray | None = None,
        cur: np.ndarray | None = None,
    ) -> float:
        feats_t, mask_t, boards_t, cur_t = self._batch_tensors(feats, mask, boards, cur)
        with torch.no_grad():
            logits = None if self.critic is not None else self._forward_logits(feats_t, mask_t, boards_t)
            return float(self._critic_value(feats_t, mask_t, cur_t, logits=logits).item())

    def observe_ppo(
        self,
        env_i: int,
        feats: np.ndarray,
        mask: np.ndarray,
        action: int,
        logp: float,
        value: float,
        reward: float,
        done: bool,
        boards: np.ndarray | None = None,
        cur: np.ndarray | None = None,
    ) -> None:
        if self._i >= self.cfg.rollout_steps:
            return
        clip = self.cfg.reward_clip
        rew = float(np.clip(reward, -clip, clip) if clip > 0 else reward)
        t = self._i
        self.roll_feats[t, env_i] = feats
        self.roll_mask[t, env_i] = mask
        if self.roll_boards is not None and boards is not None:
            self.roll_boards[t, env_i] = boards
        if self.roll_cur is not None and cur is not None:
            self.roll_cur[t, env_i] = cur
        self.roll_actions[t, env_i] = int(action)
        self.roll_logp[t, env_i] = float(logp)
        self.roll_rewards[t, env_i] = rew
        self.roll_dones[t, env_i] = float(bool(done))
        self.roll_values[t, env_i] = float(value)
        self._filled += 1
        self.env_steps += 1
        if self._filled >= self.num_envs:
            self._i += 1
            self._filled = 0

    def rollout_ready(self) -> bool:
        return self.ppo_mode and self._i >= self.cfg.rollout_steps

    def update(self, next_v: np.ndarray | None = None) -> dict[str, float]:
        if self.ppo_mode:
            return self._update_ppo(next_v)
        return self._update_bc()

    def _update_bc(self) -> dict[str, float]:
        batch = min(self.cfg.bc_batch, self.size)
        if batch < 4:
            return {}
        idx = np.random.randint(0, self.size, size=batch)
        feats = torch.from_numpy(self.feats[idx]).to(self.device)
        mask = torch.from_numpy(self.mask[idx]).to(self.device)
        target = torch.from_numpy(self.target[idx]).to(self.device)
        boards = None
        if self.boards is not None:
            boards = torch.from_numpy(self.boards[idx].astype(np.float32)).to(self.device)
        ctx = (
            torch.autocast(device_type="cuda", dtype=torch.bfloat16)
            if self._use_amp
            else torch.autocast(device_type="cpu", enabled=False)
        )
        with ctx:
            logits = self._forward_logits(feats, mask, boards)
            loss = F.cross_entropy(logits.float(), target)
        self.optimizer.zero_grad(set_to_none=True)
        loss.backward()
        nn.utils.clip_grad_norm_(self.net.parameters(), self.cfg.max_grad_norm)
        self.optimizer.step()
        self.updates += 1
        with torch.no_grad():
            acc = float((logits.argmax(dim=1) == target).float().mean().item())
        return {"loss": float(loss.item()), "bc_acc": acc}

    def _update_ppo(self, next_v: np.ndarray | None) -> dict[str, float]:
        if self._i < self.cfg.rollout_steps:
            return {}
        t, n = self.cfg.rollout_steps, self.num_envs
        if next_v is None:
            bootstrap = np.zeros(n, dtype=np.float32)
        else:
            bootstrap = np.asarray(next_v, dtype=np.float32).reshape(n)
        adv, ret = self._gae(bootstrap)
        b = t * n
        feats_np = self.roll_feats.reshape(b, MAX_CANDIDATES, AFTERSTATE_DIM)
        mask_np = self.roll_mask.reshape(b, MAX_CANDIDATES)
        actions_np = self.roll_actions.reshape(b)
        old_logp_np = self.roll_logp.reshape(b)
        adv_np = adv.reshape(b)
        ret_np = ret.reshape(b)
        adv_np = (adv_np - adv_np.mean()) / (adv_np.std() + 1e-8)
        boards_np = None
        cur_np = None
        if self.roll_boards is not None:
            boards_np = self.roll_boards.reshape(b, MAX_CANDIDATES, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)
        if self.roll_cur is not None:
            cur_np = self.roll_cur.reshape(b, RL_OBS_CHANNELS, RL_OBS_ROWS, RL_OBS_COLS)

        idx = np.arange(b)
        last: dict[str, float] = {}
        mb_size = min(self.cfg.ppo_minibatch, b)
        ctx = (
            torch.autocast(device_type="cuda", dtype=torch.bfloat16)
            if self._use_amp
            else torch.autocast(device_type="cpu", enabled=False)
        )
        for _ in range(self.cfg.ppo_epochs):
            np.random.shuffle(idx)
            for start in range(0, b, mb_size):
                mb = idx[start : start + mb_size]
                feats_t = torch.from_numpy(feats_np[mb]).to(self.device)
                mask_t = torch.from_numpy(mask_np[mb]).to(self.device)
                act_t = torch.from_numpy(actions_np[mb]).to(self.device)
                old_t = torch.from_numpy(old_logp_np[mb]).to(self.device)
                adv_t = torch.from_numpy(adv_np[mb]).to(self.device)
                ret_t = torch.from_numpy(ret_np[mb]).to(self.device)
                boards_t = None
                cur_t = None
                if boards_np is not None:
                    boards_t = torch.from_numpy(boards_np[mb].astype(np.float32)).to(self.device)
                if cur_np is not None:
                    cur_t = torch.from_numpy(cur_np[mb].astype(np.float32)).to(self.device)
                with ctx:
                    logits = self._forward_logits(feats_t, mask_t, boards_t)
                    dist = Categorical(logits=logits)
                    logp = dist.log_prob(act_t)
                    ratio = (logp - old_t).exp()
                    surr1 = ratio * adv_t
                    surr2 = ratio.clamp(1.0 - self.cfg.clip, 1.0 + self.cfg.clip) * adv_t
                    policy_loss = -torch.min(surr1, surr2).mean()
                    values = self._critic_value(feats_t, mask_t, cur_t, logits=logits)
                    value_loss = 0.5 * (values.float() - ret_t).pow(2).mean()
                    entropy = dist.entropy().mean()
                    loss = (
                        policy_loss
                        + self.cfg.value_coef * value_loss
                        - self.cfg.entropy_coef * entropy
                    )
                self.optimizer.zero_grad(set_to_none=True)
                loss.backward()
                nn.utils.clip_grad_norm_(self._param_groups(), self.cfg.max_grad_norm)
                self.optimizer.step()
                last = {
                    "loss": float(loss.item()),
                    "policy_loss": float(policy_loss.item()),
                    "value_loss": float(value_loss.item()),
                    "entropy": float(entropy.item()),
                }
        self.updates += 1
        self._reset_rollout()
        return last

    def _gae(self, next_v: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        t, n = self.cfg.rollout_steps, self.num_envs
        adv = np.zeros((t, n), dtype=np.float32)
        last_gae = np.zeros(n, dtype=np.float32)
        gamma, lam = self.cfg.gamma, self.cfg.gae_lambda
        for i in reversed(range(t)):
            nxt = next_v if i == t - 1 else self.roll_values[i + 1]
            mask = 1.0 - self.roll_dones[i]
            delta = self.roll_rewards[i] + gamma * nxt * mask - self.roll_values[i]
            last_gae = delta + gamma * lam * mask * last_gae
            adv[i] = last_gae
        ret = adv + self.roll_values
        return adv, ret

    def checkpoint(self) -> dict[str, Any]:
        hidden = self.cfg.hidden
        if not self.use_cnn:
            hidden = int(self.net.net[0].out_features)
        payload: dict[str, Any] = {
            "kind": "afterstate_ppo" if self.ppo_mode else "afterstate",
            "policy": self.net.state_dict(),
            "optimizer": self.optimizer.state_dict(),
            "env_steps": self.env_steps,
            "updates": self.updates,
            "width": self.cfg.width,
            "hidden": hidden,
            "depth": self.cfg.depth,
            "in_dim": AFTERSTATE_DIM,
            "afterstate_encoder": "cnn" if self.use_cnn else "mlp",
        }
        if self.critic is not None:
            payload["critic"] = self.critic.state_dict()
        return payload

    def load(self, payload: dict[str, Any], *, policy_only: bool = False) -> None:
        self.net.load_state_dict(payload["policy"])
        if policy_only:
            self.optimizer = optim.Adam(self._param_groups(), lr=self.cfg.lr)
            self.env_steps = 0
            self.updates = 0
            if self.ppo_mode:
                self._reset_rollout()
            return
        if self.critic is not None and "critic" in payload:
            self.critic.load_state_dict(payload["critic"])
        if "optimizer" in payload:
            try:
                self.optimizer.load_state_dict(payload["optimizer"])
            except (ValueError, RuntimeError):
                self.optimizer = optim.Adam(self._param_groups(), lr=self.cfg.lr)
        self.env_steps = int(payload.get("env_steps") or payload.get("step") or 0)
        self.updates = int(payload.get("updates") or 0)
