"""Cut onset-to-offset EEG epochs from GUI BDF and average by N-back outcome.

Uses completed GUI recording metadata and corresponding web behavior files.
Requires numpy, scipy, matplotlib, pyedflib. Originals are never modified.
"""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import tempfile

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
import pyedflib
from scipy.signal import butter, sosfiltfilt


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def label_fields(label):
    return dict(part.split('=', 1) for part in label.split(':') if '=' in part)


def average(epochs, indices):
    selected = epochs[indices]
    count = np.sum(np.isfinite(selected[:, 0, :]), axis=0)
    mean = np.divide(np.nansum(selected, axis=0), count[None, :],
                     out=np.full(selected.shape[1:], np.nan), where=count[None, :] > 0)
    return mean, count


def run(args):
    root = Path(__file__).resolve().parents[1]
    meta_path = Path(args.gui_meta).resolve()
    meta = read(meta_path)
    if meta['status'] != 'complete' and not args.allow_live_snapshot:
        raise ValueError('Stop GUI recording before epoch export')
    if meta.get('lost_samples', 0) or meta.get('invalid_frames', 0):
        raise ValueError('Recording has gaps/invalid frames; review discontinuities before filtering')
    bdf_path = meta_path.with_suffix('.bdf')
    source_bytes = bdf_path.read_bytes()
    snapshot_bytes = source_bytes
    if meta['status'] != 'complete':
        # Copy only complete data records and finalize the COPY's header. Never touch the live file.
        header_bytes = int(source_bytes[184:192])
        signal_count = int(source_bytes[252:256])
        sample_field = 256 + 216*signal_count
        samples_per_record = [int(source_bytes[sample_field+8*i:sample_field+8*(i+1)]) for i in range(signal_count)]
        record_bytes = 3*sum(samples_per_record)
        record_count = (len(source_bytes)-header_bytes)//record_bytes
        if record_count <= 0:
            raise ValueError('No complete BDF data records available')
        snapshot = bytearray(source_bytes[:header_bytes+record_count*record_bytes])
        snapshot[236:244] = str(record_count).ljust(8).encode('ascii')
        snapshot_bytes = bytes(snapshot)
    with tempfile.TemporaryDirectory(prefix='nback_bdf_') as temporary:
      snapshot_path = Path(temporary)/'snapshot.bdf'
      snapshot_path.write_bytes(snapshot_bytes)
      with pyedflib.EdfReader(str(snapshot_path)) as reader:
        channels = [i for i, name in enumerate(reader.getSignalLabels()) if name.startswith('CH')]
        if not channels:
            raise ValueError('No CH-labelled EEG channels found')
        fs = reader.getSampleFrequency(channels[0])
        if any(reader.getSampleFrequency(i) != fs or reader.getPhysicalDimension(i).strip() != 'uV' for i in channels):
            raise ValueError('Expected EEG with common sample rate and microvolt units')
        names = [reader.getLabel(i) for i in channels]
        raw = np.array([reader.readSignal(i)[:meta['timeline_samples']] for i in channels])
        onsets, _, annotations = reader.readAnnotations()
        annotation_map = dict(zip(annotations, onsets))
    if not np.isfinite(raw).all():
        raise ValueError('Non-finite EEG values')
    # Filter the continuous signal, not separate epochs. Preserve the original recording reference.
    filtered = sosfiltfilt(butter(4, [.1, 30], fs=fs, btype='bandpass', output='sos'), raw, axis=1)
    grouped = {}
    for event in meta['events']:
        if not event['label'].startswith('nback:v2:'):
            continue
        f = label_fields(event['label'])
        if args.block and f.get('b') != args.block:
            continue
        if f.get('t') == '-':
            continue
        key = (f['b'], int(f['t']))
        kind = f['e']
        if kind in grouped.setdefault(key, {}):
            raise ValueError(f'Duplicate trial event: {key} {kind}')
        annotation = f"TRIGGER code={event['code']} label={event['label']}"
        if annotation not in annotation_map or abs(annotation_map[annotation]*fs-event['sample_index']) > .1:
            raise ValueError('GUI metadata/BDF annotation mismatch')
        grouped[key][kind] = event
    before = round(.2*fs)
    records, raw_epochs, filtered_epochs, skipped = [], [], [], []
    blocks = {}
    for (block, index), ev in sorted(grouped.items(), key=lambda item:item[1].get('stimulus_onset', {}).get('sample_index', 0)):
        if block.startswith('TEST_'):
            continue
        if block not in blocks:
            behavior_path = root / 'recordings' / ('nback_'+block) / 'behavior.json'
            blocks[block] = read(behavior_path)
        behavior = blocks[block]
        if behavior['status'] != 'complete' and not args.include_interrupted:
            skipped.append(dict(block=block, index=index, reason='incomplete block'))
            continue
        results = {r['index']:r for r in behavior['results']}
        if not all(k in ev for k in ['stimulus_onset', 'stimulus_offset', 'trial_end']) or index not in results:
            skipped.append(dict(block=block, index=index, reason='missing event/result'))
            continue
        result = results[index]
        def bdf_sample(kind):
            event = ev[kind]
            annotation = f"TRIGGER code={event['code']} label={event['label']}"
            return round(float(annotation_map[annotation])*fs)
        start, stop = bdf_sample('stimulus_onset'), bdf_sample('stimulus_offset')
        if start-before < 0 or stop <= start or stop >= raw.shape[1]:
            skipped.append(dict(block=block, index=index, reason='invalid bounds', onsetSample=start, offsetSample=stop))
            continue
        if label_fields(ev['trial_end']['label'])['c'] != result['outcome']:
            raise ValueError('Behavior/BDF outcome mismatch')
        unfiltered = raw[:, start-before:stop+1].copy()
        processed = filtered[:, start-before:stop+1].copy()
        # Baseline excludes stimulus sample zero: [-200 ms, 0 ms).
        unfiltered -= unfiltered[:, :before].mean(axis=1, keepdims=True)
        processed -= processed[:, :before].mean(axis=1, keepdims=True)
        p2p = np.ptp(processed, axis=1)
        flat = np.any(p2p < .5)
        accepted = bool(np.max(p2p) <= args.reject_uv and not flat)
        duration_ms = (stop-start)*1000/fs
        expected_ms = behavior['config']['stimulusMs']
        timing_ok = abs(duration_ms-expected_ms) <= args.offset_tolerance_ms
        raw_epochs.append(unfiltered)
        filtered_epochs.append(processed)
        records.append(dict(blockId=block, index=index, subjectId=behavior['subjectId'], n=behavior['config']['n'],
                            **{k:result[k] for k in ['letter','target','scored','outcome','rtMs']},
                            onsetSample=start, offsetSample=stop, offsetMs=duration_ms, expectedDurationMs=expected_ms,
                            length=processed.shape[1], peakToPeakUv=p2p.tolist(), passesAmplitudeScreen=accepted,
                            passesDurationScreen=timing_ok,
                            onsetLabel=ev['stimulus_onset']['label'], offsetLabel=ev['stimulus_offset']['label']))
    if not records:
        raise ValueError('No complete matched epochs')
    output = Path(args.output) if args.output else root/'recordings/.exports'/('nback_epochs_'+meta['session_id']+'_'+datetime.now().strftime('%H%M%S'))
    output.mkdir(parents=True, exist_ok=False)
    if meta['status'] != 'complete':
        (output/'source_snapshot.bdf').write_bytes(snapshot_bytes)
    (output/'source_metadata.json').write_text(json.dumps(meta,indent=2),encoding='utf-8')
    max_length = max(e.shape[1] for e in raw_epochs)
    matrices = []
    for epochs in [raw_epochs, filtered_epochs]:
        matrix = np.full((len(epochs), len(channels), max_length), np.nan)
        for i, epoch in enumerate(epochs):
            matrix[i, :, :epoch.shape[1]] = epoch
        matrices.append(matrix)
    times = (np.arange(max_length)-before)/fs
    np.savez_compressed(output/'epochs.npz', raw_baseline_uv=matrices[0], filtered_baseline_uv=matrices[1],
                        times_seconds=times, lengths=[r['length'] for r in records], channel_names=names,
                        trial_metadata_json=json.dumps(records))
    averages, groups = {}, []
    colors = {'hit':'#2463a6', 'correct_rejection':'#be5a2a'}
    for subject, n in sorted(set((r['subjectId'],r['n']) for r in records)):
        group_records = [i for i,r in enumerate(records) if r['subjectId']==subject and r['n']==n]
        for screened in [False, True]:
            means, counts, numbers = {}, {}, {}
            for outcome in ['hit', 'correct_rejection']:
                idx = [i for i in group_records if records[i]['outcome']==outcome and (not screened or (records[i]['passesAmplitudeScreen'] and records[i]['passesDurationScreen']))]
                if not idx:
                    continue
                means[outcome], counts[outcome] = average(matrices[1], idx)
                numbers[outcome] = len(idx)
            if not means:
                continue
            key = f'{subject}_{n}back_'+('screened' if screened else 'all_correct')
            groups.append(dict(key=key, subjectId=subject, n=n, screened=screened, trials=numbers))
            for outcome in means:
                averages[key+'_'+outcome] = means[outcome]
                averages[key+'_'+outcome+'_n'] = counts[outcome]
            fig = plt.figure(figsize=(12, 12))
            grid = fig.add_gridspec(5, 2, height_ratios=[1, 1, 1, 1, .7])
            axes = np.empty((4,2), dtype=object)
            for pos in range(8):
                axes.flat[pos] = fig.add_subplot(grid[pos//2, pos%2],
                    sharex=None if pos==0 else axes.flat[0], sharey=None if pos==0 else axes.flat[0])
            for ch, ax in enumerate(axes.flat):
                if ch>=len(names):
                    ax.set_visible(False)
                    continue
                for outcome in means:
                    ax.plot(times*1000, means[outcome][ch], color=colors[outcome], lw=1.5,
                            label=f'{outcome} (n={numbers[outcome]})')
                ax.axvline(0, color='.5', lw=.7)
                ax.axhline(0, color='.5', lw=.7)
                ax.set_title(names[ch], fontsize=11)
                ax.set_ylabel('Amplitude (uV)')
                if ch>=6: ax.set_xlabel('Time from BDF onset annotation (ms)')
                ax.spines[['top','right']].set_visible(False)
                ax.grid(alpha=.15)
            axes[0,0].legend(fontsize=8)
            count_ax = fig.add_subplot(grid[4,:], sharex=axes.flat[0])
            for outcome in counts:
                count_ax.step(times*1000, counts[outcome], where='mid', color=colors[outcome], label=outcome)
            count_ax.set_ylabel('Contributing trials')
            count_ax.set_xlabel('Time from BDF onset annotation (ms)')
            count_ax.set_title('Trial count falls after each actual offset; no time stretching', fontsize=10)
            count_ax.spines[['top','right']].set_visible(False)
            mode = f'Screened: <= {args.reject_uv:g} uV p-p; offset within +/-{args.offset_tolerance_ms:g} ms of configured duration' if screened else 'All behaviorally correct trials; artifacts NOT rejected'
            fig.suptitle(f'{subject} | {n}-back | BDF onset-to-offset average\n{mode}', fontsize=13)
            fig.text(.5,.014,f'Source: {meta["session_id"]}.bdf | Block: {args.block or "all selected"} | 0.1-30 Hz, baseline -200 to <0 ms\nEEG and timing from BDF; web supplies outcome labels. Original reference; channel locations unknown. n=1 is a single trial.',ha='center',fontsize=8)
            fig.tight_layout(rect=[0,.065,1,.94])
            fig.savefig(output/(key+'.png'),dpi=170)
            fig.savefig(output/(key+'.pdf'))
            plt.close(fig)
            fig, ax = plt.subplots(figsize=(9,3))
            for outcome in counts:
                ax.step(times*1000, counts[outcome],where='mid',color=colors[outcome],label=outcome)
            ax.set(xlabel='Time from GUI onset trigger (ms)',ylabel='Contributing trials',title=key+' | Actual epoch support')
            ax.legend();fig.tight_layout();fig.savefig(output/(key+'_counts.png'),dpi=140);plt.close(fig)
    np.savez_compressed(output/'averages.npz', times_seconds=times, channel_names=names, **averages)
    (output/'trials.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
    report = dict(sourceBdf=str(bdf_path), sourceSha256=hashlib.sha256(source_bytes).hexdigest(),
        sourceStatus=meta['status'], snapshotSha256=hashlib.sha256(snapshot_bytes).hexdigest(), selectedBlock=args.block,
        guiSession=meta['session_id'], channels=names, sampleRate=fs, epochCount=len(records),
        blockCount=len(blocks), outcomes=dict(Counter(r['outcome'] for r in records)),
        amplitudeScreenThresholdUv=args.reject_uv, passAmplitudeScreen=sum(r['passesAmplitudeScreen'] for r in records),
        durationScreenToleranceMs=args.offset_tolerance_ms, passBothScreens=sum(r['passesAmplitudeScreen'] and r['passesDurationScreen'] for r in records),
        offsetRangeMs=[min(r['offsetMs'] for r in records),max(r['offsetMs'] for r in records)], groups=groups, skipped=skipped,
        method=['EEG and epoch timing taken from BDF full data records (read-only snapshot when source is still recording).',
                'Web behavior supplies outcome labels, checked against BDF labels by full block UUID and trial index; web EEG/timing is not used.',
                'Epochs include 200 ms baseline and stop at the actual stimulus_offset BDF annotation.',
                'No time warping. NaN padding denotes absent samples; means use available trials at each time point.',
                'Filtered data: continuous 4th-order Butterworth 0.1-30 Hz, forward/backward, baseline [-200,0) ms.',
                'Original reference retained; no ICA or automatic channel interpolation. Amplitude screening is exploratory.',
                'Warmups and behavior errors are saved in epochs but excluded from the two main averages.',
                'Known software-trigger jitter remains; no claim about P300 presence or precise peak latency.'])
    (output/'summary.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    (output/'README.md').write_text('# N-back epochs and averages\n\n'+ '\n'.join('- '+x for x in report['method'])+
        '\n\n`epochs.npz`: trial x channel x time in microvolts, NaN after each actual offset. '
        '`averages.npz`: condition means plus per-timepoint counts. `trials.json`: trial order and QC. '
        'PNG/PDF: all-correct and amplitude-screened averages. Compare screened and unscreened outputs; a small retained set is not a reliable ERP.\n',encoding='utf-8')
    print(json.dumps(report,indent=2))
    print('OUTPUT',output)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('gui_meta')
    parser.add_argument('--output')
    parser.add_argument('--block', help='Only this complete block UUID')
    parser.add_argument('--include-interrupted', action='store_true', help='Use only completed trials within an interrupted block')
    parser.add_argument('--allow-live-snapshot', action='store_true', help='Read a copy of complete BDF records without stopping GUI recording')
    parser.add_argument('--reject-uv',type=float,default=200.)
    parser.add_argument('--offset-tolerance-ms',type=float,default=100.)
    args=parser.parse_args()
    if args.reject_uv<=0 or args.offset_tolerance_ms<0:parser.error('reject-uv must be positive; offset-tolerance-ms must be nonnegative')
    run(args)
