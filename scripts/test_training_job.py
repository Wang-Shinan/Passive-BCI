import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location('training_job', Path(__file__).with_name('training-job.py'))
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)


class SplitTests(unittest.TestCase):
    def test_group_isolation_coverage_and_repeatability(self):
        labels = np.tile(np.repeat(np.arange(4), 3), 5)
        groups = [f'{session}:{trial}' for session in range(5) for trial in range(4) for _ in range(3)]
        splits = job.grouped_split(labels, groups, 4)
        self.assertEqual(sorted(np.concatenate(splits).tolist()), list(range(len(labels))))
        seen = set()
        for idx in splits:
            keys = {groups[i] for i in idx}
            self.assertFalse(seen & keys)
            seen.update(keys)
            self.assertEqual(set(labels[idx]), {0, 1, 2, 3})
        for a, b in zip(splits, job.grouped_split(labels, groups, 4)):
            np.testing.assert_array_equal(a, b)

    def test_impossible_coverage_rejected(self):
        with self.assertRaises(ValueError):
            job.grouped_split(np.array([0, 1, 2, 3]), ['a', 'b', 'c', 'd'], 0)
        with self.assertRaises(ValueError):
            job.grouped_split(np.array([0, 1]), ['a', 'b'], 0)

    def test_fit_artifacts_with_controlled_frozen_features(self):
        # Exercise real H5 IO, optimization, evaluation, and serving checkpoint;
        # replace only expensive encoder loading/inference with fixed features.
        import torch
        from bci_dayloop.data.hdf5_dataset import HDF5Metadata, write_hdf5
        from bci_dayloop.serving import reve
        import fit_smr_control_head

        class Backend:
            def __init__(self, **kwargs):
                self._head = torch.nn.Linear(4, 4)
                self.encoder_id = 'reve-base'

            def load(self):
                pass

        def encode(backend, windows):
            labels = torch.tensor([w.class_id for w in windows])
            return torch.eye(4)[labels], labels

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            labels = np.tile(np.arange(4), 5)
            write_hdf5(root / 'dataset.h5', np.zeros((20, 2, 500), dtype=np.float32), labels,
                       np.ones(20, dtype=np.int64), [str(i // 4) for i in range(20)], np.arange(20),
                       HDF5Metadata(250, ['C3', 'C4'], ['left_hand', 'right_hand', 'both_hand', 'rest'], 'uV', 'smr_control'))
            config = dict(dataset=str(root / 'dataset.h5'), splitBy='session', seed=0, size='base', device='cpu',
                          loraCheckpoint=None, epochs=3, lr=.02, headOutput=str(root / 'published.pt'))
            job_file = root / 'job.json'
            job_file.write_text(json.dumps(dict(id='test', kind='fit', config=config)), encoding='utf-8')
            with patch.object(sys, 'argv', ['training-job.py', '--ncc', str(NCC), '--job', str(job_file)]), \
                    patch.object(reve, 'ReveModelBackend', Backend), patch.object(fit_smr_control_head, 'encode_windows', encode):
                job.main()
            report = json.loads((root / 'report.json').read_text(encoding='utf-8'))
            self.assertEqual([report['metrics'][key]['count'] for key in ('train', 'validation', 'test')], [12, 4, 4])
            checkpoint = torch.load(root / 'published.pt', weights_only=True)
            self.assertEqual(checkpoint['task'], 'smr_control')
            self.assertEqual(tuple(checkpoint['head']['weight'].shape), (4, 4))


if __name__ == '__main__':
    NCC = Path(sys.argv.pop(1))
    sys.path[:0] = [str(NCC / 'src'), str(NCC / 'scripts')]
    unittest.main()
