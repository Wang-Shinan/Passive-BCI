import tempfile
import unittest
from pathlib import Path
import numpy as np
import torch
from serve_eegnet_tetris import load_model, predict, hello_payload

class WeightsTests(unittest.TestCase):
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
            with self.assertRaisesRegex(ValueError, 'requires 8 channels'):
                predict(restored, {**header, 'channels': 32}, data)
            payload = torch.load(a, weights_only=True)
            payload['class_names'] = ['wrong']
            torch.save(payload, b)
            with self.assertRaisesRegex(ValueError, 'class|order'):
                load_model(b)

if __name__ == '__main__': unittest.main()
