"""Local code and separately provisioned weights; never discover an external checkout."""
import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[5]

def checkpoint_root() -> Path:
    return Path(os.environ.get('REVE_CHECKPOINT_ROOT', str(PROJECT_ROOT / 'checkpoints' / 'backbones'))).resolve()

def adapter_root() -> Path:
    return Path(os.environ.get('REVE_ADAPTER_ROOT', str(PROJECT_ROOT / 'checkpoints' / 'adapters'))).resolve()
