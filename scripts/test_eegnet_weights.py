import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from serve_eegnet_tetris import load_model, predict, hello_payload, fit_window

class WeightsTests(unittest.TestCase):
    def test_ignored_channels_are_masked_in_saved_model(self):
        with tempfile.TemporaryDirectory() as folder:
            checkpoint = Path(folder) / 'masked.pt'
            load_model(channels=32, output=checkpoint)
            payload = torch.load(checkpoint, weights_only=True)
            payload['ignored_channels'] = list(range(16, 32))
            torch.save(payload, checkpoint)
            model = load_model(checkpoint)
            header = dict(channels=32, samples=500, sample_rate=250)
            data = np.random.default_rng(8).normal(size=(32, 500)).astype('<f4')
            expected = fit_window(model, header, data.tobytes())
            data[16:] = np.nan
            torch.testing.assert_close(fit_window(model, header, data.tobytes()), expected, rtol=0, atol=0)
            self.assertEqual(torch.count_nonzero(expected[:, :, 16:]).item(), 0)
            self.assertTrue(hello_payload(model)['supports_group_training'])
            payload['ignored_channels'] = [32]
            torch.save(payload, checkpoint)
            with self.assertRaisesRegex(ValueError, 'ignored_channels'):
                load_model(checkpoint)

    def test_constant_adc_rails_normalize_to_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            model = load_model(channels=8, output=Path(folder) / 'rail.pt')
            data = np.full((8, 500), -187500.03125, dtype='<f4')
            data[::2] *= -1
            window = fit_window(model, dict(channels=8, samples=500, sample_rate=250), data.tobytes())
            self.assertEqual(torch.count_nonzero(window).item(), 0)

    def test_random_reload_and_distinct_weights(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as folder:
            a = Path(folder) / 'a.pt'; b = Path(folder) / 'b.pt'
            initial = load_model(seed=11, channels=8, output=a)
            restored = load_model(a)
            other = load_model(seed=12, channels=8, output=b)
            data = np.random.default_rng(1).normal(size=(8, 500)).astype('<f4').tobytes()
            header = dict(channels=8, samples=500, sample_rate=250, request_id='t', segment_id='s')
            first = predict(initial, header, data)
            self.assertEqual(first['probabilities'], predict(restored, header, data)['probabilities'])
            self.assertEqual(first['model_revision'], restored.config['revision'])
            self.assertNotEqual(first['model_revision'], other.config['revision'])
            self.assertEqual(hello_payload(restored)['input']['channels'], 8)
            self.assertTrue(hello_payload(restored)['accepts_window_stream'])
            with self.assertRaisesRegex(ValueError, 'requires 8 channels'):
                predict(restored, {**header, 'channels': 32}, data)
            payload = torch.load(a, weights_only=True)
            payload['class_names'] = ['wrong']
            torch.save(payload, b)
            with self.assertRaisesRegex(ValueError, 'class|order'):
                load_model(b)

if __name__ == '__main__': unittest.main()
