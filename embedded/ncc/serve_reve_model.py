from __future__ import annotations

import argparse
import json
from pathlib import Path

import sys
_EMBED_SRC = Path(__file__).resolve().parent / "src"
if str(_EMBED_SRC) not in sys.path:
    sys.path.insert(0, str(_EMBED_SRC))
from bci_dayloop.serving.reve import (
    ReveModelBackend,
    default_checkpoint_root,
    default_serve_strategy,
    normalize_reve_task,
)
from bci_dayloop.serving.reve_lora import default_stieger_lora_checkpoint
from bci_dayloop.serving.server import run_model_service
from bci_dayloop.serving.tcp_broadcast import DEFAULT_TCP_PORT


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Serve local REVE weights over WebSocket for Passive BCI (2s windows)."
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8768)
    parser.add_argument("--size", choices=("base", "large"), default="base")
    parser.add_argument("--device", default="auto")
    parser.add_argument(
        "--strategy",
        default=None,
        help="Online strategy. Default: none for smr_control, supervised-head otherwise.",
    )
    parser.add_argument(
        "--task",
        default="passive_rating",
        help="passive_rating (任务一/任务二/任务三), tetris_action (7 Tetris ops), or smr_control (left/right/tongue/rest).",
    )
    parser.add_argument(
        "--step-sec",
        type=float,
        default=None,
        help=(
            "Live decode hop advertised in hello. Default: 0.1s for tetris_action, "
            "0.5s otherwise. Passive-BCI Tetris pages pass 0.1 even on smr_control. "
            "Offline export/fit must not use this value (they use hop=window)."
        ),
    )
    parser.add_argument("--lr", type=float, default=0.05)
    parser.add_argument("--state-file", type=Path, default=None)
    parser.add_argument(
        "--checkpoint-root",
        type=Path,
        default=default_checkpoint_root(),
        help="Directory containing reve-base / reve-large / reve-positions.",
    )
    parser.add_argument(
        "--lora-checkpoint",
        type=Path,
        default=None,
        help="Optional PEFT LoRA training checkpoint (best.pt) merged into frozen REVE.",
    )
    parser.add_argument(
        "--no-lora",
        action="store_true",
        help="Do not auto-load the Stieger SMR LoRA when task=smr_control.",
    )
    parser.add_argument("--tcp-host", default="0.0.0.0", help="LAN follow TCP bind host.")
    parser.add_argument("--tcp-port", type=int, default=DEFAULT_TCP_PORT)
    parser.add_argument("--no-tcp", action="store_true", help="Disable JSONL TCP follow stream.")
    parser.add_argument("--omni-endpoint", help="Direct ESP32 SDK endpoint, e.g. ble://<discovered-key>.")
    parser.add_argument("--omni-relay", action="store_true", help="Share the acquisition page SDK owner on localhost:8772.")
    parser.add_argument("--omni-channels", help="Comma-separated electrode names in hardware CH1..CH8 order; no assumed montage.")
    parser.add_argument("--omni-electrodes", help="Optional electrode position names separate from channel labels.")
    parser.add_argument("--omni-positions", help="Optional JSON array of 8 XYZ triples, metres in the REVE position-bank frame.")
    args = parser.parse_args()
    if args.task == 'smr_dual_axis':
        if args.state_file is None:
            parser.error('smr_dual_axis requires a dual-axis manifest --state-file')
        if args.omni_endpoint or args.omni_relay:
            parser.error('S04 dual-axis models require the trained 31 EEG electrodes, not Omni 8-channel input')
        from bci_dayloop.serving.reve_dual_axis import DualAxisReveBackend
        backend = DualAxisReveBackend(args.checkpoint_root / f'reve-{args.size}', args.checkpoint_root / 'reve-positions',
            args.state_file, device=args.device, step_sec=args.step_sec or .5)
        backend.load()
        run_model_service(backend, host=args.host, port=args.port, tcp_host=args.tcp_host, tcp_port=args.tcp_port, tcp_enabled=not args.no_tcp)
        return
    omni_config = None
    if args.omni_endpoint or args.omni_channels or args.omni_relay or args.omni_electrodes or args.omni_positions:
        from bci_dayloop.serving.omni_source import OmniSourceConfig
        if not args.omni_endpoint or not args.omni_channels:
            parser.error("--omni-endpoint and --omni-channels must be supplied together")
        try:
            if args.omni_electrodes and args.omni_positions:
                parser.error("Use either --omni-electrodes or --omni-positions")
            omni_config = OmniSourceConfig(args.omni_endpoint, tuple(name.strip() for name in args.omni_channels.split(",")), relay=args.omni_relay,
                electrode_names=tuple(name.strip() for name in args.omni_electrodes.split(",")) if args.omni_electrodes else None,
                electrode_positions=json.loads(args.omni_positions) if args.omni_positions else None)
        except ValueError as error:
            parser.error(str(error))
    root = args.checkpoint_root.resolve()
    model_dir = root / f"reve-{args.size}"
    positions_dir = root / "reve-positions"
    if not (model_dir / "model.safetensors").is_file():
        raise SystemExit(f"Missing REVE weights: {model_dir / 'model.safetensors'}")
    if not (positions_dir / "model.safetensors").is_file():
        raise SystemExit(f"Missing REVE positions: {positions_dir}")

    lora_checkpoint = args.lora_checkpoint
    if lora_checkpoint is None and not args.no_lora and normalize_reve_task(args.task) in ("smr_control", "gaze_smr"):
        lora_checkpoint = default_stieger_lora_checkpoint()

    strategy = args.strategy if args.strategy else default_serve_strategy(args.task)
    backend = ReveModelBackend(
        model_dir=model_dir,
        positions_dir=positions_dir,
        device=args.device,
        strategy=strategy,
        task=args.task,
        step_sec=args.step_sec,
        lr=args.lr,
        state_file=args.state_file,
        lora_checkpoint=lora_checkpoint,
    )
    backend.load()
    if omni_config is not None and omni_config.electrode_positions is None:
        from bci_dayloop.serving.reve import resolve_channel_name
        mapped = [resolve_channel_name(name, backend._lookup) for name in (omni_config.electrode_names or omni_config.channel_names)]
        if any(name is None for name in mapped) or len(set(mapped)) != 8:
            parser.error("--omni-channels must map to 8 distinct REVE electrode positions; CH1..CH8 placeholders are not positions")
    state_note = f" state-file={backend.state_file}" if backend.state_file else ""
    print(
        f"[model-service] REVE size={args.size} device={backend.torch_device_name} "
        f"task={backend.task} classes={len(backend.class_names)} "
        f"encoder={backend.encoder_id} "
        f"strategy={backend.strategy} window={backend.window_sec:g}s "
        f"step={backend.step_sec:g}s target={backend.target_hz:g}Hz{state_note}"
    )
    if omni_config is not None:
        import asyncio
        from bci_dayloop.serving.omni_service import serve_omni_model_service
        asyncio.run(serve_omni_model_service(
            backend, omni_config, host=args.host, port=args.port,
            tcp_host=args.tcp_host, tcp_port=args.tcp_port, tcp_enabled=not args.no_tcp,
        ))
        return
    run_model_service(
        backend,
        host=args.host,
        port=args.port,
        tcp_host=args.tcp_host,
        tcp_port=args.tcp_port,
        tcp_enabled=not args.no_tcp,
    )


if __name__ == "__main__":
    main()
