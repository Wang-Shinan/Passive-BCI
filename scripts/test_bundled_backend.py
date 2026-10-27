"""No weights or hardware required: isolated imports, HDF5, LP and real mock WebSocket IO."""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / 'embedded/ncc'
sys.path[:0] = [str(BACKEND / 'src'), str(BACKEND / 'scripts')]
import numpy as np
import torch

class BundledBackendTests(unittest.TestCase):
    def test_isolated_imports(self):
        subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'scripts/probe-ncc-embed.py')], check=True, timeout=30)

    def test_hdf5_roundtrip_and_linear_head(self):
        from bci_dayloop.data.hdf5_dataset import HDF5Metadata, EEGHDF5, write_hdf5
        from fit_smr_control_head import train_linear_head
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / 'data.h5'
            labels = np.tile(np.arange(4, dtype=np.int64), 4)
            eeg = np.arange(16 * 2 * 50, dtype=np.float32).reshape(16, 2, 50)
            write_hdf5(target, eeg, labels, np.ones(16, dtype=int), ['session'] * 16, np.arange(16), HDF5Metadata(25, ['C3', 'C4'], ['left', 'right', 'tongue', 'rest'], 'uV', 'fixture'))
            loaded = EEGHDF5(target).load()
            np.testing.assert_array_equal(loaded['data'], eeg)
            np.testing.assert_array_equal(loaded['labels'], labels)
            features = torch.eye(4).repeat(4, 1)
            head = torch.nn.Linear(4, 4)
            train_linear_head(head, features, torch.tensor(labels), epochs=40, lr=.05)
            self.assertTrue(torch.equal(head(features).argmax(1), torch.tensor(labels)))

    def test_cli_entries(self):
        for script in ('serve_runtime_model.py', 'serve_dev_mock_model.py', 'fit_smr_control_head.py', 'fit_gaze_smr_head.py', 'export_smr_control_hdf5.py'):
            with self.subTest(script=script):
                entry = str(BACKEND / 'scripts' / script)
                code = f'import sys,runpy;sys.path.insert(0,{str(BACKEND / "scripts")!r});sys.argv=[{entry!r},"--help"];runpy.run_path({entry!r},run_name="__main__")'
                subprocess.run([sys.executable, '-I', '-B', '-c', code], check=True, stdout=subprocess.DEVNULL, timeout=30)

    def test_mock_roundtrip_via_node_launcher(self):
        from bci_dayloop.serving.profiles import BCIGO32_PROFILE
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        env = {**os.environ, 'PASSIVE_BCI_PYTHON': sys.executable, 'MODEL_SERVICE_PORT': str(port), 'MODEL_NO_TCP': '1',
               'NCC_OI_BCI_ROOT': '/does-not-exist', 'NCC_EMBED': '0', 'MODEL_PACKAGE': ''}
        with tempfile.TemporaryFile(mode='w+') as log:
            process = subprocess.Popen(['node', str(ROOT / 'scripts/run-model-service.mjs'), '--backend', 'mock', '--profile', 'bcigo32'], env=env, cwd=tempfile.gettempdir(), stdout=log, stderr=log)
            async def exercise():
                from websockets.asyncio.client import connect
                for _ in range(100):
                    try:
                        ws = await connect(f'ws://127.0.0.1:{port}/v1/model')
                        break
                    except OSError:
                        if process.poll() is not None: raise RuntimeError('Mock process exited')
                        await asyncio.sleep(.1)
                else: raise TimeoutError('Mock failed to listen')
                async with ws:
                    hello = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    self.assertEqual(hello['model']['type'], 'mock')
                    profile = BCIGO32_PROFILE
                    header = dict(type='window', schema_version=1, request_id='isolated-test', window_id=1, segment_id='test',
                                  channel_names=list(profile.channel_names), channels=profile.channels, samples=profile.samples,
                                  sample_rate=profile.sample_rate, unit='uV', layout='CT')
                    await ws.send(json.dumps(header))
                    await ws.send(np.zeros((profile.channels, profile.samples), dtype='<f4').tobytes())
                    result = json.loads(await asyncio.wait_for(ws.recv(), 5))
                    self.assertEqual(result['type'], 'prediction', result)
                    self.assertEqual(result['request_id'], 'isolated-test')
                    self.assertEqual(result['model_revision'], 'mock')
            try:
                asyncio.run(exercise())
            except Exception:
                log.seek(0); print(log.read()); raise
            finally:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()

if __name__ == '__main__':
    unittest.main()
