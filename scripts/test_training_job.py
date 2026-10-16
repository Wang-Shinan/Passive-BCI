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
    def test_history_union_keeps_every_round_holdout_out_of_training(self):
        from grouped_probe import fixed_split, history_split
        with tempfile.TemporaryDirectory() as folder:
            labels = np.tile(np.arange(4), 5)
            rounds, all_groups, all_sessions = [], [], []
            for n in range(2):
                session = f'round{n}'
                groups = [f'{session}:{i}' for i in range(20)]
                ledger = Path(folder) / f'{n}.json'
                fixed_split(labels, groups, ledger, n)
                rounds.append(dict(id=str(n), seed=n, sessions=[str(Path(folder) / session)], splitLedger=str(ledger)))
                all_groups.extend(groups); all_sessions.extend([session] * 20)
            indices, snapshot, counts = history_split(np.tile(labels, 2), all_groups, all_sessions, {'rounds': rounds})
            self.assertEqual([len(idx) for idx in indices], [24, 8, 8])
            self.assertEqual(len(snapshot), 64)
            self.assertEqual(len(counts), 2)
            for role, idx in zip(('train', 'validation', 'test'), indices):
                for i in idx:
                    ledger = json.loads(Path(rounds[i // 20]['splitLedger']).read_text())
                    self.assertEqual(ledger['assignments'][all_groups[i]], role)
            with self.assertRaisesRegex(ValueError, '未登记'):
                history_split(np.tile(labels, 2), all_groups, all_sessions, {'rounds': rounds[:1]})

    def test_fixed_split_keeps_holdouts_when_new_groups_arrive(self):
        from grouped_probe import fixed_split
        labels = np.repeat(np.arange(4), 10)
        groups = [f'first:{label}:{trial}' for label in range(4) for trial in range(5) for _ in range(2)]
        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / 'split.json'
            old, snapshot = fixed_split(labels, groups, ledger, 9)
            extra_labels = np.tile(np.arange(4), 2)
            extended = groups + [f'second:{i}' for i in range(8)]
            new, next_snapshot = fixed_split(np.concatenate([labels, extra_labels]), extended, ledger, 9)
            self.assertEqual(snapshot, next_snapshot)
            np.testing.assert_array_equal(old[1], new[1])
            np.testing.assert_array_equal(old[2], new[2])
            self.assertTrue(set(range(40, 48)).issubset(new[0]))
            self.assertEqual(len(set(groups[i] for i in old[1]) & set(groups[i] for i in old[0])), 0)
            with self.assertRaises(ValueError):
                fixed_split(labels[1:], groups[1:], ledger, 10)

    def test_insufficient_trials_do_not_create_a_split(self):
        from grouped_probe import fixed_split, InsufficientTrials
        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / 'split.json'
            with self.assertRaises(InsufficientTrials):
                fixed_split(np.arange(4), ['a', 'b', 'c', 'd'], ledger, 0)
            self.assertFalse(ledger.exists())

    def test_sealed_recordings_reject_modified_eeg(self):
        from grouped_probe import seal_recordings
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            recording = root / 'group1'; recording.mkdir()
            (recording / 'eeg.json').write_text(json.dumps({'format': 'float32-le-interleaved', 'unit': 'uV'}))
            (recording / 'session.json').write_text('{}')
            (recording / 'events.jsonl').write_text('{}\n')
            (recording / 'eeg.bin').write_bytes(b'1234')
            manifest = root / 'sealed.json'
            first = seal_recordings([recording], manifest)
            self.assertEqual(first, seal_recordings([recording], manifest))
            (recording / 'eeg.bin').write_bytes(b'5678')
            with self.assertRaisesRegex(ValueError, '内容改变'):
                seal_recordings([recording], manifest)

    def test_promotion_requires_gain_and_per_class_guard(self):
        from grouped_probe import promotion_decision
        current = {'balancedAccuracy': .5, 'recalls': [.5] * 4}
        candidate = {'balancedAccuracy': .75, 'recalls': [.75] * 4}
        self.assertTrue(promotion_decision(current, candidate, .02, 0)['promote'])
        self.assertFalse(promotion_decision(current, current, 0, 0)['promote'])
        candidate['recalls'][0] = .1
        self.assertFalse(promotion_decision(current, candidate, .02, .1)['promote'])

    def test_adaptive_fit_excludes_test_data_and_preserves_serving_preprocessing(self):
        import torch
        import h5py
        from bci_dayloop.data.hdf5_dataset import HDF5Metadata, write_hdf5
        from bci_dayloop.serving import reve
        import fit_smr_control_head
        encoded_trials = []

        class Backend:
            def __init__(self, **kwargs):
                self._head = torch.nn.Linear(4, 4)
                torch.nn.init.zeros_(self._head.weight); torch.nn.init.zeros_(self._head.bias)
                self.encoder_id = 'reve-base'
                self.model_revision = 'original'
                self.feature_normalization = 'none'
                self.input_clip = 7.
                self.preprocessing_profile = 's04-mne-4s-v1'
                self.input_channel_names = tuple(f'EEG{i}' for i in range(31))
                self.window_sec = 4
            def load(self):
                pass

        def encode(backend, windows):
            encoded_trials.extend(int(w.data[0, 0]) for w in windows)
            labels = torch.tensor([w.class_id for w in windows])
            return torch.eye(4)[labels], labels

        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            labels = np.tile(np.arange(4), 5)
            data = np.zeros((20, 2, 1000), dtype=np.float32)
            data[:, 0, 0] = np.arange(20)
            write_hdf5(root / 'dataset.h5', data, labels, np.ones(20, dtype=np.int64), ['group1'] * 20, np.arange(20),
                       HDF5Metadata(250, ['C3', 'C4'], ['left_hand', 'right_hand', 'tongue', 'rest'], 'uV', 'smr_control'))
            with h5py.File(root / 'dataset.h5', 'a') as handle:
                handle.create_dataset('source_trial_ids', data=np.arange(20))
            config = dict(dataset=str(root / 'dataset.h5'), splitBy='trial', seed=0xffffffff, size='base', device='cpu',
                          loraCheckpoint=None, epochs=3, lr=.02, headOutput=str(root / 'published.pt'),
                          roundId='round', splitLedger=str(root / 'split.json'), baselineRevision='original',
                          baselineOutput=str(root / 'baseline.pt'), minimumGain=.02, maximumRecallDrop=0.)
            job_file = root / 'job.json'
            job_file.write_text(json.dumps(dict(id='adaptive', kind='fit', config=config)), encoding='utf-8')
            with patch.object(sys, 'argv', ['training-job.py', '--ncc', str(NCC), '--job', str(job_file)]), \
                    patch.object(reve, 'ReveModelBackend', Backend), patch.object(fit_smr_control_head, 'encode_windows', encode):
                job.main()
            report = json.loads((root / 'report.json').read_text(encoding='utf-8'))
            self.assertNotIn('test', report['metrics'])
            self.assertTrue(report['decision']['promote'])
            self.assertFalse(set(report['splitIndices'][2]) & set(encoded_trials))
            self.assertEqual(report['testReserved'], 4)
            baseline = torch.load(root / 'baseline.pt', weights_only=True)
            candidate = torch.load(root / 'published.pt', weights_only=True)
            self.assertEqual(baseline['model_revision'], 'original')
            self.assertEqual(candidate['feature_normalization'], 'none')
            self.assertEqual(candidate['input_clip'], 7.)
            self.assertEqual(candidate['preprocessing_profile'], 's04-mne-4s-v1')
            self.assertEqual(candidate['input_window_sec'], 4)
            self.assertTrue(torch.equal(baseline['head']['weight'], torch.zeros(4, 4)))

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
                self.preprocessing_profile = None
                self.input_channel_names = ()
                self.window_sec = 2

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
                       HDF5Metadata(250, ['C3', 'C4'], ['left_hand', 'right_hand', 'tongue', 'rest'], 'uV', 'smr_control'))
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
