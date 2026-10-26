"""Read-only backend environment/asset check. Never installs or downloads."""
import argparse
import importlib.metadata
import json
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--require-weights', action='store_true')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / 'embedded/ncc/src'))
from bci_dayloop.serving.embed_paths import checkpoint_root, adapter_root
packages = {}
missing = []
for name in ('torch', 'numpy', 'transformers', 'einops', 'safetensors', 'websockets', 'scipy', 'h5py', 'peft', 'mne', 'scikit-learn', 'PyYAML'):
    try:
        packages[name] = importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        missing.append(name)
assets = {name: {filename: (checkpoint_root() / name / filename).is_file()
                for filename in ('config.json', 'model.safetensors')} for name in ('reve-base', 'reve-positions')}
print(json.dumps({'python': sys.executable, 'backend': str(root / 'embedded/ncc'), 'packages': packages,
                  'missingPackages': missing, 'checkpointRoot': str(checkpoint_root()),
                  'adapterRoot': str(adapter_root()), 'assets': assets,
                  'note': 'Asset presence is not an inference or GPU validation.'}, indent=2))
raise SystemExit(1 if missing or (args.require_weights and not all(all(a.values()) for a in assets.values())) else 0)
