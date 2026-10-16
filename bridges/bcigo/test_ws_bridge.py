import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

import bcigo_sdk as sdk
import numpy as np

from ws_bridge import BciGoSession, normalize_eeg_batch, start_sdk_eeg


class StartupTests(unittest.IsolatedAsyncioTestCase):
    def client(self, config_error=None, mode_error=None):
        return SimpleNamespace(start_data_stream=AsyncMock(),
            set_eeg_config=AsyncMock(side_effect=config_error),
            start_eeg_stream=AsyncMock(side_effect=mode_error),
            disconnect_tcp=AsyncMock(), stop_eeg_stream=AsyncMock())

    async def test_legacy_config_reply_still_requires_explicit_mode_ack(self):
        client = self.client(RuntimeError('EEG mode acknowledgement mismatch: expected 1, got 0'))
        await start_sdk_eeg(client, sdk, 'parser', 250, 6, 'normal')
        client.start_data_stream.assert_awaited_once_with('parser')
        client.set_eeg_config.assert_awaited_once_with(sdk.EegSampleRate.SR_250Hz,
            sdk.EegSignalGain.GAIN_6, sdk.EegSignalSource.NORMAL)
        client.start_eeg_stream.assert_awaited_once()

    async def test_other_configuration_errors_are_not_ignored(self):
        client = self.client(RuntimeError('EEG configuration mismatch'))
        with self.assertRaisesRegex(RuntimeError, 'configuration mismatch'):
            await start_sdk_eeg(client, sdk, 'parser', 250, 6, 'normal')
        client.start_eeg_stream.assert_not_awaited()

    async def test_explicit_mode_failure_is_not_reported_as_connected(self):
        client = self.client(RuntimeError('EEG mode acknowledgement mismatch: expected 1, got 0'),
                             RuntimeError('mode command rejected'))
        with self.assertRaisesRegex(RuntimeError, 'mode command rejected'):
            await start_sdk_eeg(client, sdk, 'parser', 250, 6, 'normal')

    async def test_failed_start_still_disconnects_tcp(self):
        session = BciGoSession(None, None, 250, 6, 'normal', 'BCIGo', 32, 8, None)
        client = self.client()
        session._client = client
        await session.stop()
        client.disconnect_tcp.assert_awaited_once()
        client.stop_eeg_stream.assert_not_awaited()


class SampleTests(unittest.TestCase):
    def test_all_ten_sample_fields_are_kept_in_order(self):
        for prefix in ('sample', 'sample_'):
            raw = {f'{prefix}{i}': [float(i)] * 32 for i in range(1, 11)}
            rows = normalize_eeg_batch(raw, 32)
            self.assertEqual(rows.shape, (10, 32))
            np.testing.assert_array_equal(rows[:, 0], np.arange(1, 11))


if __name__ == '__main__':
    unittest.main()
