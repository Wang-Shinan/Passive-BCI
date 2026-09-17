"""Measure local WebSocket ping RTT and EEG delivery cadence without sending triggers.

Requires websockets. RTT is not one-way or ADC-to-browser latency.
"""
import asyncio
from datetime import datetime
import json
from pathlib import Path
import statistics
import time

import websockets


def distribution(values):
    values = sorted(values)
    if not values:
        return None
    return dict(count=len(values), min=min(values), median=statistics.median(values),
                mean=statistics.mean(values), p95=values[round((len(values)-1)*.95)], max=max(values))


async def measure(url, count=100):
    rtts, receipts, sizes, sequences, errors = [], [], [], [], []
    source_timestamp_count = 0
    async with websockets.connect(url, open_timeout=5, close_timeout=1, ping_interval=None) as ws:
        async def receive():
            nonlocal source_timestamp_count
            async for raw in ws:
                now = time.perf_counter_ns()/1e6
                msg = json.loads(raw)
                if msg.get('type') != 'eeg':
                    continue
                frames = msg['frames']
                receipts.append(now)
                sizes.append(len(frames))
                sequences.extend(f['sequence'] for f in frames)
                source_timestamp_count += sum(f.get('source_timestamp_ms') is not None for f in frames)
        receiver = asyncio.create_task(receive())
        try:
            for _ in range(count):
                start = time.perf_counter_ns()
                pong = await ws.ping()
                try:
                    await asyncio.wait_for(pong, 2)
                    rtts.append((time.perf_counter_ns()-start)/1e6)
                except asyncio.TimeoutError:
                    errors.append('ping timeout')
                    if len(errors) >= 2:
                        # A send-only server may never poll incoming Ping frames.
                        await asyncio.sleep(6)
                        break
                await asyncio.sleep(.1)
        finally:
            receiver.cancel()
            try:
                await receiver
            except asyncio.CancelledError:
                pass
    return dict(url=url, pingRttMs=distribution(rtts), pingErrors=errors,
                batchIntervalsMs=distribution([b-a for a,b in zip(receipts, receipts[1:])]),
                samplesPerBatch=distribution(sizes), totalSamples=len(sequences),
                sequenceDiscontinuities=sum(b != (a+1) % 2**32 for a,b in zip(sequences,sequences[1:])),
                sourceTimestampsPresent=source_timestamp_count, rawRttMs=rtts,
                notes='Local Python client ping/pong RTT; excludes browser rendering and does not measure one-way ADC latency.')


async def main():
    results = await asyncio.gather(measure('ws://127.0.0.1:8766/v1/stream'),
                                   measure('ws://127.0.0.1:5173/ws/omni-native'))
    path = Path(__file__).resolve().parents[1] / 'recordings/.exports' / ('websocket_latency_'+datetime.now().strftime('%Y%m%d_%H%M%S')+'.json')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(json.dumps([{k:v for k,v in r.items() if k!='rawRttMs'} for r in results], indent=2))
    print('SAVED',path)


if __name__ == '__main__':
    asyncio.run(main())
