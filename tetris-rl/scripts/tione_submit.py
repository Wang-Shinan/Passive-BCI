#!/usr/bin/env python3
"""Submit tetris-rl training jobs to TI-ONE (1×H20 each).

Uses the platform PreSet GPU image (torch 2.8 + CUDA 12.8) and CFS-mounted
code at /mnt/cfs-omni/wsn/Passive-BCI/tetris-rl. Must run from a TI-ONE notebook.

Examples:
  python scripts/tione_submit.py
  python scripts/tione_submit.py --algo dagger,iql,pqn
  python scripts/tione_submit.py --submit
"""
from __future__ import annotations

import argparse
import importlib.util
import os
from datetime import datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_LAUNCHER = Path(__file__).resolve().parent / "tione_entrypoint.sh"
_SUBMITTER = Path(
    os.environ.get(
        "NEUROMIX_SUBMITTER",
        "/mnt/cfs-omni/kexin/neuromix/scripts/tione/submit_training_job.py",
    )
)
_COS_ENV_FILE = Path("/mnt/cfs-omni/kexin/.cos_creds")
PLATFORM_IMAGE = (
    "tione.tencentcloudcr.com/qcloud-ti-platform/notebook-conda-gpu:"
    "verl0.6.1-vllm0.11.0-torch2.8-py312-cuda12.8-gpu"
)

# Skip pure PPO: it collapsed to a single action and never cleared lines.
DEFAULT_ALGOS = ["bc", "dagger", "iql", "dqn", "bc_ppo", "pqn"]
CONFIGS = {
    "bc": "configs/bc_h20.json",
    "dagger": "configs/dagger_h20.json",
    "iql": "configs/iql_h20.json",
    "dqn": "configs/dqn_h20.json",
    "bc_ppo": "configs/bc_ppo_h20.json",
    "pqn": "configs/pqn_h20.json",
    "ppo": "configs/ppo_h20.json",
}


def _prime_cos_env() -> None:
    if os.environ.get("COS_ACCESS_KEY") and os.environ.get("COS_SECRET_KEY"):
        return
    aws_id = os.environ.get("AWS_ACCESS_KEY_ID", "")
    aws_key = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
    if not aws_id and _COS_ENV_FILE.is_file():
        loaded: dict[str, str] = {}
        for raw in _COS_ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, value = line.split("=", 1)
            loaded[name.strip()] = value.strip().strip("\"'")
        aws_id = loaded.get("AWS_ACCESS_KEY_ID", "")
        aws_key = loaded.get("AWS_SECRET_ACCESS_KEY", "")
        os.environ.setdefault("COS_REGION", loaded.get("AWS_REGION", "ap-beijing"))
        endpoint = loaded.get("AWS_ENDPOINT") or loaded.get("AWS_ENDPOINT_URL") or ""
        if endpoint:
            os.environ.setdefault("COS_ENDPOINT", endpoint)
    if not aws_id or not aws_key:
        raise SystemExit("COS/AWS credentials not found in env or .cos_creds")
    os.environ["COS_ACCESS_KEY"] = aws_id
    os.environ["COS_SECRET_KEY"] = aws_key
    os.environ.setdefault("COS_REGION", os.environ.get("AWS_REGION", "ap-beijing"))
    os.environ.setdefault(
        "COS_ENDPOINT",
        os.environ.get("AWS_ENDPOINT")
        or os.environ.get("AWS_ENDPOINT_URL")
        or "https://cos.ap-beijing.myqcloud.com",
    )


def _load_submitter():
    spec = importlib.util.spec_from_file_location("nm_submit", _SUBMITTER)
    if spec is None or spec.loader is None:
        raise SystemExit(f"cannot import submitter: {_SUBMITTER}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--algo",
        default=",".join(DEFAULT_ALGOS),
        help="comma-separated algos (default: bc,dagger,iql,dqn,bc_ppo,pqn)",
    )
    p.add_argument("--submit", action="store_true")
    p.add_argument("--gpu", type=int, default=1)
    p.add_argument("--gpu-type", default="H20")
    p.add_argument("--cpu", type=int, default=32)
    p.add_argument("--mem", type=int, default=128)
    p.add_argument("--charge-type", default="PREPAID", choices=["PREPAID", "POSTPAID_BY_HOUR"])
    p.add_argument(
        "--collect",
        action="store_true",
        help="submit offline BFS collect instead of training",
    )
    p.add_argument(
        "--collect-args",
        default="",
        help="extra args for scripts/collect_offline.py",
    )
    a = p.parse_args()

    _prime_cos_env()
    mod = _load_submitter()
    mod.TCR_REGISTRY_ID = None
    mod.TCR_REGISTRY_REGION = None
    stamp = datetime.now().strftime("%m%d%H%M%S")
    created: list[str] = []

    if a.collect:
        collect_launcher = Path(__file__).resolve().parent / "tione_collect.sh"
        if not collect_launcher.is_file():
            raise SystemExit(f"missing launcher {collect_launcher}")
        name = f"tetris-collect-{stamp}"
        extra_args = a.collect_args.strip() or (
            "--device auto --depth 3 --beam 256 "
            "--min-episodes 8 --min-cleared 8 --min-lines 80 "
            "--min-clear-events 16 --min-transitions 2000 "
            "--max-episodes 16 --max-steps 800 "
            f"--out runs/offline/{name}.npz"
        )
        kwargs = mod.build_training_task(
            name=name,
            config="configs/collect_offline.json",
            launcher=str(collect_launcher),
            extra_args=extra_args,
            gpu=a.gpu,
            gpu_type=a.gpu_type,
            nodes=1,
            charge_type=a.charge_type,
            cpu=a.cpu,
            mem=a.mem,
            image_url=PLATFORM_IMAGE,
            image_type="PreSet",
        )
        print(f"[tione] name={name} collect extra={extra_args}")
        print(f"[tione] image={PLATFORM_IMAGE} type=PreSet")
        if a.submit:
            client = mod.get_client()
            resp = client.create_training_task(**kwargs)
            print(f"created {resp.Id}")
            print(f"console: https://console.cloud.tencent.com/tione/training/detail/{resp.Id}")
            created.append(resp.Id)
        else:
            print("[tione] dry run; pass --submit to create")
        return 0

    algos = [x.strip() for x in a.algo.split(",") if x.strip()]
    unknown = [x for x in algos if x not in CONFIGS]
    if unknown:
        raise SystemExit(f"unknown algo {unknown}; known: {sorted(CONFIGS)}")
    if not _LAUNCHER.is_file():
        raise SystemExit(f"missing launcher {_LAUNCHER}")

    for algo in algos:
        name = f"tetris-{algo.replace('_', '-')}-{stamp}"
        extra_args = f"--run-name {name}"
        kwargs = mod.build_training_task(
            name=name,
            config=CONFIGS[algo],
            launcher=str(_LAUNCHER),
            extra_args=extra_args,
            gpu=a.gpu,
            gpu_type=a.gpu_type,
            nodes=1,
            charge_type=a.charge_type,
            cpu=a.cpu,
            mem=a.mem,
            image_url=PLATFORM_IMAGE,
            image_type="PreSet",
        )
        print(f"[tione] name={name} config={CONFIGS[algo]} extra={extra_args}")
        print(f"[tione] image={PLATFORM_IMAGE} type=PreSet")
        if not a.submit:
            continue
        client = mod.get_client()
        resp = client.create_training_task(**kwargs)
        task_id = resp.Id
        created.append(task_id)
        print(f"created {task_id}")
        print(f"console: https://console.cloud.tencent.com/tione/training/detail/{task_id}")

    if not a.submit:
        print("[tione] dry run; pass --submit to create")
    elif created:
        print(f"[tione] submitted {len(created)} tasks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
