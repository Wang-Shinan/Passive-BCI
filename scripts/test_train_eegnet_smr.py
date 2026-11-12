import json
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

import numpy as np
import torch

import train_eegnet_smr as trainer
from serve_eegnet_tetris import fit_window, load_model

ROWS = 11000
CHANNELS = 2
RATE = 250
SAMPLES = 500
TRIALS = 10


def _raw_bytes():
    raw = np.zeros((ROWS, CHANNELS), dtype='<f4')
    raw[:, 0] = np.arange(ROWS, dtype=np.float32)
    raw[:, 1] = np.arange(ROWS, dtype=np.float32) * 10
    return raw.tobytes()


def write_session(folder: Path, *, meta_status='complete', session_status='complete',
                  valid=True, missing_feedback_at=None, ambiguous_class=False,
                  channels=CHANNELS, rate=RATE):
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'eeg.bin').write_bytes(_raw_bytes())
    meta = dict(status=meta_status, channels=channels, sampleRate=rate, unit='uV',
                layout='sample-major', dtype='float32', endian='le',
                channelNames=['CH1', 'CH2'], clock=dict(sampleIndex=ROWS))
    (folder / 'eeg.json').write_text(json.dumps(meta), encoding='utf-8')
    session = dict(status=session_status, subjectId='S-test')
    (folder / 'session.json').write_text(json.dumps(session), encoding='utf-8')
    events = [dict(type='session_start', eeg=dict(sampleIndex=0), data={})]
    for t in range(TRIALS):
        start, end = t * 1100 + 100, t * 1100 + 1100
        target, cls = ('down', 'rest') if t < 5 else ('up', 'tongue')
        if ambiguous_class:
            cls = 'up' if t < 5 else 'left_hand'
        if missing_feedback_at != t:
            events.append(dict(type='feedback_start', eeg=dict(sampleIndex=start),
                               data=dict(run=1, index=t)))
        events.append(dict(type='trial', eeg=dict(sampleIndex=end),
                           data=dict(run=1, index=t, target=target, className=cls,
                                     valid=valid, feedbackSec=6)))
    events.append(dict(type='group_end', eeg=dict(sampleIndex=ROWS),
                       data=dict(run=1, complete=True)))
    (folder / 'events.jsonl').write_text(
        '\n'.join(json.dumps(e) for e in events), encoding='utf-8')
    return folder


def make_model(out: Path):
    weights = out / 'weights.pt'
    load_model(seed=7, channels=CHANNELS, output=weights)
    original_bytes = weights.read_bytes()
    model = load_model(weights)
    return model, weights, original_bytes


def fit_inputs(model, windows):
    header = dict(channels=model.config['channels'], samples=model.config['samples'],
                  sample_rate=model.config['sample_rate'], unit='uV', layout='CT')
    return torch.cat([fit_window(model, header, w.tobytes()) for w in windows])


class PrepareDatasetTests(unittest.TestCase):
    def test_windows_split_and_metadata(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = write_session(root / 'session-a')
            out = root / 'out'
            out.mkdir()
            model, weights, original_bytes = make_model(root)
            before = {n: (session_dir / n).read_bytes()
                      for n in ('eeg.bin', 'eeg.json', 'session.json', 'events.jsonl')}

            x, y, groups, indices, report = trainer.prepare_dataset([session_dir], model, out)

            self.assertEqual(x.shape, (TRIALS * 2, CHANNELS, SAMPLES))
            # windows sit strictly inside actual feedback bounds (no cue rows)
            np.testing.assert_array_equal(x[0, 0], np.arange(100, 600, dtype=np.float32))
            np.testing.assert_array_equal(x[1, 0], np.arange(600, 1100, dtype=np.float32))
            self.assertTrue((x[0, 0] < 600).all() and (x[0, 0] >= 100).all())
            # split: per-class chronological holdout, trials never split
            names = list(model.config['class_names'])
            rest = sorted(set(groups[y == names.index('rest')].tolist()))
            tongue = sorted(set(groups[y == names.index('tongue')].tolist()))
            split = report['split_groups']
            # classes are held out in label-index order: tongue (2) then rest (3)
            self.assertEqual(split['train'], tongue[:3] + rest[:3])
            self.assertEqual(split['validation'], tongue[3:4] + rest[3:4])
            self.assertEqual(split['test'], tongue[4:5] + rest[4:5])
            combined = split['train'] + split['validation'] + split['test']
            self.assertEqual(len(combined), len(set(combined)))
            self.assertEqual(sorted(set(combined)), sorted(set(rest + tongue)))
            self.assertEqual(report['observed_class_names'], ['tongue', 'rest'])
            self.assertEqual(set(y.tolist()), {names.index('tongue'), names.index('rest')})
            self.assertEqual(report['sample_timing'], 'received_samples')
            with np.load(out / 'dataset.npz', allow_pickle=False) as npz:
                sub_idx = {k: npz[k].copy() for k in ('train', 'validation', 'test')}
            for subset, want in (('train', split['train']), ('validation', split['validation']),
                                 ('test', split['test'])):
                self.assertEqual(set(groups[sub_idx[subset]].tolist()), set(want))
            # no overlapping trial groups across subsets
            for i, a in enumerate(('train', 'validation', 'test')):
                for b in ('train', 'validation', 'test')[i + 1:]:
                    self.assertFalse(set(groups[sub_idx[a]].tolist()) & set(groups[sub_idx[b]].tolist()))
            # sources untouched
            for n, content in before.items():
                self.assertEqual((session_dir / n).read_bytes(), content)
            self.assertEqual(weights.read_bytes(), original_bytes)

    def test_invalid_inputs_raise_without_padding(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            model, _, _ = make_model(root)
            cases = {
                'recording': dict(meta_status='recording'),
                'session-open': dict(session_status='recording'),
                'ambiguous': dict(ambiguous_class=True),
                'invalid-trial': dict(valid=False),
                'missing-boundary': dict(missing_feedback_at=3),
                'bad-channels': dict(channels=8),
                'bad-rate': dict(rate=1000),
            }
            for name, kwargs in cases.items():
                with self.subTest(case=name):
                    out = root / f'out-{name}'
                    out.mkdir()
                    session_dir = write_session(root / f'session-{name}', **kwargs)
                    with self.assertRaises(Exception):
                        trainer.prepare_dataset([session_dir], model, out)


class TrainStageTests(unittest.TestCase):
    def test_lp_freezes_encoder_and_ft_updates_it(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = write_session(root / 'session-a')
            out = root / 'out'
            out.mkdir()
            model, weights, original_bytes = make_model(root)
            x, y, groups, indices, dataset = trainer.prepare_dataset([session_dir], model, out)
            inputs = fit_inputs(model, x)
            encoder_base = trainer.state_hash(model.encoder.state_dict())
            classifier_base = trainer.state_hash(model.classifier.state_dict())

            metrics = iter([
                dict(balanced_accuracy=0.0, negative_log_likelihood=2.0),
                dict(balanced_accuracy=0.5, negative_log_likelihood=1.0),
                dict(balanced_accuracy=1.0, negative_log_likelihood=0.0),
            ])
            with mock.patch.object(trainer, 'trial_metrics', side_effect=lambda *a, **k: next(metrics)):
                lp = trainer.train_stage(model, inputs, y, groups, indices,
                                         stage='lp', epochs=2, lr=.001, seed=7)
            self.assertEqual(lp['selected_epoch'], 2)
            # encoder fully frozen incl. BatchNorm running buffers
            self.assertEqual(trainer.state_hash(model.encoder.state_dict()), encoder_base)
            self.assertNotEqual(trainer.state_hash(model.classifier.state_dict()), classifier_base)

            metrics = iter([
                dict(balanced_accuracy=0.0, negative_log_likelihood=2.0),
                dict(balanced_accuracy=0.5, negative_log_likelihood=1.0),
                dict(balanced_accuracy=1.0, negative_log_likelihood=0.0),
            ])
            with mock.patch.object(trainer, 'trial_metrics', side_effect=lambda *a, **k: next(metrics)):
                ft = trainer.train_stage(model, inputs, y, groups, indices,
                                         stage='ft', epochs=2, lr=.0001, seed=7)
            self.assertEqual(ft['selected_epoch'], 2)
            self.assertNotEqual(trainer.state_hash(model.encoder.state_dict()), encoder_base)

            # production loader round-trips the artifact, class contract unchanged
            original = torch.load(weights, map_location='cpu', weights_only=True)
            path = trainer.save_checkpoint(model, original, out / 'fine_tuned.pt', 'ft', dataset)
            restored = load_model(Path(path))
            self.assertEqual(list(restored.config['class_names']), list(original['class_names']))
            self.assertEqual(weights.read_bytes(), original_bytes)


class CliSmokeTests(unittest.TestCase):
    def test_cli_writes_report_with_decision(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = write_session(root / 'session-a')
            out = root / 'run'  # must not exist; the CLI creates it
            _, weights, original_bytes = make_model(root)
            run = subprocess.run(
                [sys.executable, str(Path(__file__).resolve().parent / 'train_eegnet_smr.py'),
                 '--sessions', str(session_dir), '--checkpoint', str(weights), '--output', str(out),
                 '--seed', '7', '--minimum-gain', '0.99'],
                capture_output=True, text=True, timeout=600)
            self.assertEqual(run.returncode, 0, run.stderr[-2000:])
            report = json.loads((out / 'report.json').read_text(encoding='utf-8'))
            for key in ('promote', 'stage', 'gain', 'max_recall_drop', 'checkpoint', 'revision', 'reason'):
                self.assertIn(key, report['decision'])
            self.assertIn('baseline_validation', report)
            for stage in ('lp', 'ft'):
                self.assertIn('validation', report['stages'][stage])
                self.assertIn('test', report['stages'][stage])
                self.assertIn('checkpoint', report['stages'][stage])
            # unpromoted decision must point back at the baseline checkpoint
            if not report['decision']['promote']:
                self.assertEqual(report['decision']['checkpoint'],
                                 report['baseline_checkpoint'])
            self.assertEqual(weights.read_bytes(), original_bytes)


if __name__ == '__main__':
    unittest.main()
