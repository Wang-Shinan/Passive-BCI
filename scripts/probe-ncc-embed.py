"""Prove the embedded serving slice imports without the rest of NCC."""
from __future__ import annotations

import sys
from pathlib import Path

embed_src = Path(sys.argv[1]).resolve()
ncc_src = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 and sys.argv[2] else None
sys.path.insert(0, str(embed_src))

import bci_dayloop.serving.reve as reve
import bci_dayloop.serving.server as server

forbidden = (
    "bci_dayloop.packages",
    "bci_dayloop.packages.loader",
    "bci_dayloop.models",
    "bci_dayloop.preprocessing",
    "bci_dayloop.data",
    "bci_dayloop.realtime",
)
loaded = [name for name in forbidden if name in sys.modules]
reve_file = Path(reve.__file__).resolve()
server_file = Path(server.__file__).resolve()
if embed_src not in reve_file.parents or embed_src not in server_file.parents:
    raise SystemExit(f"embedded import resolved outside the slice:\n{reve_file}\n{server_file}")
if loaded:
    raise SystemExit("embedded import pulled excluded NCC packages: " + ", ".join(loaded))
checkpoint = reve.default_checkpoint_root()
print(f"embed-reve={reve_file}")
print(f"embed-server={server_file}")
print(f"checkpoint-root={checkpoint}")
print("embed-import=ok")

if ncc_src is None:
    raise SystemExit(0)

# A second interpreter is not available here. Drop the embedded modules and
# import the sibling checkout to confirm the original package is still intact.
for name in list(sys.modules):
    if name == "bci_dayloop" or name.startswith("bci_dayloop."):
        del sys.modules[name]
sys.path.insert(0, str(ncc_src))
import bci_dayloop.serving.reve as external

external_file = Path(external.__file__).resolve()
if ncc_src not in external_file.parents:
    raise SystemExit(f"external import did not use the sibling checkout: {external_file}")
print(f"external-reve={external_file}")
print("external-import=ok")
