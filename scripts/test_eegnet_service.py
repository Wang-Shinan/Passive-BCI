"""Exercise random and saved EEGNet through the real Node/WebSocket entry, without EEG hardware."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import numpy as np
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]

async def run(checkpoint, output):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    args = ['node', str(ROOT / 'scripts/run-model-service.mjs'), '--backend', 'eegnet', '--channels', '8']
    args += ['--checkpoint', str(checkpoint)] if checkpoint else ['--seed', '29', '--output', str(output)]
    with tempfile.TemporaryFile(mode='w+') as log:
        process = subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=log,
            env={**os.environ, 'PASSIVE_BCI_PYTHON':sys.executable, 'MODEL_SERVICE_PORT':str(port), 'MODEL_PACKAGE':''})
        try:
            for _ in range(150):
                try:
                    ws = await connect(f'ws://127.0.0.1:{port}/v1/model'); break
                except OSError:
                    if process.poll() is not None: raise RuntimeError('EEGNet exited')
                    await asyncio.sleep(.1)
            else: raise TimeoutError('EEGNet startup timed out')
            async with ws:
                hello = json.loads(await asyncio.wait_for(ws.recv(), 5))
                assert hello['model']['type'] == 'eegnet'
                assert hello['input']['channels'] == 8
                await ws.send(json.dumps(dict(type='window', schema_version=1, request_id='test', window_id=1,
                    segment_id='test', channels=8, samples=500, sample_rate=250, unit='uV', layout='CT')))
                await ws.send(np.random.default_rng(1).normal(size=(8,500)).astype('<f4').tobytes())
                reply = json.loads(await asyncio.wait_for(ws.recv(), 5))
                assert reply['type'] == 'prediction', reply
                assert reply['model_revision'] == hello['online']['model_revision']
                return reply
        except Exception:
            log.seek(0); print(log.read()); raise
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()

async def main():
    with tempfile.TemporaryDirectory() as folder:
        saved = Path(folder)/'random.pt'
        first = await run(None, saved)
        loaded = await run(saved, None)
        assert first['model_revision'] == loaded['model_revision']
        assert first['logits'] == loaded['logits']
        print('EEGNet random -> saved checkpoint: real WebSocket predictions and revision match')

if __name__ == '__main__': asyncio.run(main())
