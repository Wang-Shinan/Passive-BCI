"""Weight locations for the in-tree serving slice.

Code lives in Passive-BCI. Checkpoints stay in the sibling NCC checkout,
or in REVE_CHECKPOINT_ROOT / REVE_ADAPTER_ROOT.
"""
from __future__ import annotations

import os
from pathlib import Path


def ncc_checkout() -> Path | None:
    env = os.environ.get("NCC_OI_BCI_ROOT", "").strip()
    if env and Path(env).is_dir():
        return Path(env)
    workspace = Path(__file__).resolve().parents[6]
    sibling = workspace / "NCC-OI-BCI"
    if sibling.is_dir():
        return sibling
    return None


def checkpoint_root() -> Path:
    override = os.environ.get("REVE_CHECKPOINT_ROOT", "").strip()
    if override:
        return Path(override)
    ncc = ncc_checkout()
    if ncc is not None:
        return ncc / "checkpoints" / "backbones"
    return Path(__file__).resolve().parents[3] / "checkpoints" / "backbones"


def adapter_root() -> Path:
    override = os.environ.get("REVE_ADAPTER_ROOT", "").strip()
    if override:
        return Path(override)
    ncc = ncc_checkout()
    if ncc is not None:
        return ncc / "checkpoints" / "adapters"
    return Path(__file__).resolve().parents[3] / "checkpoints" / "adapters"
