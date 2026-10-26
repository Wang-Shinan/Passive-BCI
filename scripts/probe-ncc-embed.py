"""Import the bundled service and training helpers without an external checkout."""
import sys
from pathlib import Path
root = Path(__file__).resolve().parents[1] / 'embedded' / 'ncc'
sys.path[:0] = [str(root / 'src'), str(root / 'scripts')]
import bci_dayloop.serving.reve
import bci_dayloop.serving.server
import bci_dayloop.data.hdf5_dataset
import fit_smr_control_head
import fit_gaze_smr_head
import bci_dayloop.packages.loader
for name, module in list(sys.modules.items()):
    if name.startswith('bci_dayloop') and getattr(module, '__file__', None):
        if root not in Path(module.__file__).resolve().parents:
            raise SystemExit(f'External module loaded: {name}: {module.__file__}')
print('bundled-service-and-training-imports=ok')
