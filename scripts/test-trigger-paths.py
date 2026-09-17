"""Send paired test triggers to OmniBCI HTTP and a recording browser on localhost.

Requires websockets. Run while BOTH applications record native EEG.
Writes JSONL evidence and a JSON summary. Never retries uncertain triggers.
"""
import argparse
import asyncio
from datetime import datetime
import json
from pathlib import Path
import statistics
import time
import urllib.request
import uuid

import websockets


def stamp():
    return dict(wallUnixMs=time.time_ns() / 1e6, monotonicNs=time.perf_counter_ns())


def request_json(url, data=None):
    request = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.load(response)


def http_trigger(url, event):
    sent = stamp()
    try:
        ack = request_json(url + '/v1/trigger', dict(code=event['code'], label=event['eventId']))
        return dict(sent=sent, received=stamp(), ack=ack)
    except Exception as error:
        return dict(sent=sent, received=stamp(), error=str(error))


def stats(values):
    if not values:
        return None
    values = sorted(values)
    return dict(n=len(values), min=values[0], median=statistics.median(values),
                mean=statistics.mean(values), max=values[-1],
                p95=values[min(len(values)-1, int((len(values)-1)*.95+.5))])


async def run(args):
    root = Path(__file__).resolve().parents[1]
    run_id = 'TRIGGER_TEST_' + datetime.now().strftime('%Y%m%d_%H%M%S') + '_' + uuid.uuid4().hex[:6]
    output = root / 'recordings' / '.exports' / run_id
    output.mkdir(parents=True)
    peers = {}
    pending = {}
    results = []

    async def handler(ws):
        peers[ws] = None
        try:
            async for text in ws:
                msg = json.loads(text)
                if msg.get('type') == 'status':
                    peers[ws] = msg
                elif msg.get('type') == 'trigger_ack':
                    future = pending.get((ws, msg.get('eventId')))
                    if future and not future.done():
                        future.set_result(dict(ack=msg, received=stamp()))
        finally:
            peers.pop(ws, None)

    async def web_trigger(ws, event):
        future = asyncio.get_running_loop().create_future()
        pending[(ws, event['eventId'])] = future
        sent = stamp()
        try:
            await ws.send(json.dumps({**event, 'webSendClock': sent}))
            return dict(sent=sent, **await asyncio.wait_for(future, 5))
        except Exception as error:
            return dict(sent=sent, received=stamp(), error=str(error))
        finally:
            pending.pop((ws, event['eventId']), None)

    async with websockets.serve(handler, '127.0.0.1', 8782,
                                origins=['http://127.0.0.1:5173', 'http://localhost:5173'], max_size=65536):
        print('Waiting for exactly one browser recording native EEG (port 8782)...', flush=True)
        deadline = time.monotonic() + args.wait
        while True:
            for peer in list(peers):
                try:
                    await peer.send(json.dumps(dict(type='status')))
                except websockets.ConnectionClosed:
                    pass
            await asyncio.sleep(.3)
            ready = [(ws, state) for ws, state in peers.items() if state and state.get('ready')]
            if len(ready) > 1:
                raise RuntimeError('Multiple recording browser tabs; keep only the intended receiver')
            if ready:
                ws, state = ready[0]
                break
            if time.monotonic() > deadline:
                raise RuntimeError('No recording browser receiver. Open acquisition page and start native EEG recording.')
        health = await asyncio.to_thread(request_json, args.gui + '/health')
        if not health.get('streaming') or not health.get('session_id'):
            raise RuntimeError('GUI must also be recording')
        web_session = state['session']['rel']
        print('GUI session:', health['session_id'], 'Browser session:', web_session, flush=True)
        with (output / 'pairs.jsonl').open('w', encoding='utf-8') as log:
            for index in range(args.count):
                event = dict(type='trigger_test', code=65533, eventId=f'{run_id}_{index:03d}',
                             runId=run_id, index=index, emittedClock=stamp())
                gui, web = await asyncio.gather(asyncio.to_thread(http_trigger, args.gui, event), web_trigger(ws, event))
                row = dict(event=event, gui=gui, web=web)
                ga, wa = gui.get('ack', {}), web.get('ack', {})
                if ga.get('accepted') and wa.get('accepted') and ga.get('session_id') == health['session_id'] and wa.get('session', {}).get('rel') == web_session:
                    gui_ms = datetime.fromisoformat(ga['host_time']).timestamp()*1000
                    eeg = wa['eeg']
                    sequence_diff = ((eeg['native']['sequence']-ga['sequence']+2**31) % 2**32)-2**31
                    row['comparison'] = dict(
                        webMinusGuiHostMs=wa['systemClock']['wallUnixMs']-gui_ms,
                        webMinusGuiSequenceSamples=sequence_diff,
                        webMinusGuiSequenceMs=sequence_diff*1000/eeg['sampleRate'],
                        dispatchSkewMs=(web['sent']['monotonicNs']-gui['sent']['monotonicNs'])/1e6,
                        guiRoundtripMs=(gui['received']['monotonicNs']-gui['sent']['monotonicNs'])/1e6,
                        webRoundtripMs=(web['received']['monotonicNs']-web['sent']['monotonicNs'])/1e6,
                        webLastBatchAgeMs=wa['systemClock']['monotonicMs']-eeg['arrivalNowMs'])
                results.append(row)
                log.write(json.dumps(row, ensure_ascii=False)+'\n')
                log.flush()
                print(index+1, '/', args.count, row.get('comparison', {'ERROR': row}), flush=True)
                if 'comparison' not in row:
                    break  # Do not retry ambiguous writes or continue after recording stops.
                if index+1 < args.count:
                    await asyncio.sleep(args.interval)
    # Compare actual persisted records, not only transport acknowledgements.
    events_path = (root / web_session / 'events.jsonl').resolve()
    if not events_path.is_relative_to(root / 'recordings'):
        raise RuntimeError('Unexpected browser recording path')
    stored = {}
    for line in events_path.read_text(encoding='utf-8').splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get('type') == 'external_trigger_test':
            stored[event.get('data', {}).get('eventId')] = event
    bdf = Path(args.gui_recordings) / (health['session_id']+'.bdf')
    # An active BDF has an unfinished record count. Inspect annotation text without altering it.
    bdf_bytes = bdf.read_bytes() if bdf.is_file() else None
    verification = []
    for row in results:
        label = row['event']['eventId']
        disk_event = stored.get(label)
        verification.append(dict(eventId=label,
            webEventSaved=disk_event is not None,
            webClockMatchesAck=disk_event is not None and disk_event.get('systemClock') == row['web'].get('ack', {}).get('systemClock'),
            guiBdfAnnotationSaved=None if bdf_bytes is None else ('TRIGGER code=65533 label='+label).encode() in bdf_bytes))
    compared = [r['comparison'] for r in results if 'comparison' in r]
    summary = dict(runId=run_id, requested=args.count, completed=len(compared),
        guiSession=health['session_id'], webSession=web_session, guiBdf=str(bdf),
        statistics={key: stats([r[key] for r in compared]) for key in compared[0]} if compared else {},
        verification=verification,
        interpretation=[
            'Host delta = browser receipt wall clock minus GUI acceptance host clock, on this same computer.',
            'Sequence delta compares latest EEG frames visible at each receiver, not file-relative sample indices.',
            'Dispatch skew is recorded: the two independent sends are concurrent, not physically simultaneous.',
            'HTTP acknowledgement includes GUI processing/write confirmation; RTT is not one-way latency.',
            'Browser batching and scheduling affect frame delta. This is software-path latency, not ADC or visual-onset latency.',
            'BDF verification checks the unique annotation text in the live file; stop recording for a finalized BDF export.' ])
    (output / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    print('RESULT',str(output),flush=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2),flush=True)
    if len(compared) != args.count or not all(v['webEventSaved'] and v['webClockMatchesAck'] and v['guiBdfAnnotationSaved'] for v in verification):
        raise RuntimeError('Test incomplete or persistence not verified; inspect evidence')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--count', type=int, default=20)
    parser.add_argument('--interval', type=float, default=1.)
    parser.add_argument('--wait', type=float, default=60.)
    parser.add_argument('--gui', default='http://127.0.0.1:8766')
    parser.add_argument('--gui-recordings', default=str(Path.home() / 'Desktop/omniBCI-R/target/release/recordings'))
    args = parser.parse_args()
    if not 1 <= args.count <= 10000 or args.interval < .1 or args.wait <= 0:
        parser.error('count must be 1..10000, interval >= 0.1 s, wait > 0 s')
    asyncio.run(run(args))
