"""Frozen REVE + SMR LoRA, independent direction LP from recorded EEG trials."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import os
import shutil
from types import SimpleNamespace
import numpy as np
import torch
from _bootstrap import ROOT
from fit_smr_control_head import encode_windows, train_linear_head, save_state
from bci_dayloop.serving.reve import ReveModelBackend, default_checkpoint_root
from bci_dayloop.serving.reve_lora import default_stieger_lora_checkpoint
from bci_dayloop.serving.smr_sessions import load_ct_bin

CLASSES = ('left','right','up','down')

def extract_session(folder: Path, subject: str, allow_cued_control: bool = False):
    meta = json.loads((folder/'session.json').read_text(encoding='utf-8'))
    eeg = json.loads((folder/'eeg.json').read_text(encoding='utf-8'))
    events = [json.loads(s) for s in (folder/'events.jsonl').read_text(encoding='utf-8').splitlines() if s.strip()]
    start = next(e for e in events if e['type']=='session_start')
    cfg = start['data']
    closed_training = cfg.get('mode') == 'train' and cfg.get('protocol') == 'gaze-assisted-smr-closed-loop-v1'
    if closed_training or (allow_cued_control and cfg.get('mode') == 'control'):
        if (meta.get('status') != 'complete' or meta.get('subjectId') != subject
            or cfg.get('targetLayout') != 'single-edge-v1'
            or cfg.get('labelsAre') != 'cued_edge_control_with_feedback'
            or not any(e['type'] == 'session_end' for e in events)
            or any(e['type'] == 'session_abort' for e in events)):
            raise ValueError('Requires completed, explicitly cued edge-control session')
        hz = float(eeg['sampleRate']); names = tuple(eeg['channelNames'])
        data = load_ct_bin(folder/'eeg.bin', len(names))
        origin = int(meta['clock']['sampleIndex']) - data.shape[1]
        results = [e for e in events if e['type'] == 'gaze_edge_result']
        if len(results) != len(cfg['trials']): raise ValueError('Missing trial results')
        windows = []; seen = set()
        for result in results:
            d = result['data']; idx = int(d['index']); target = d['target']
            if idx in seen or target not in CLASSES: raise ValueError('Duplicate or unknown trial')
            seen.add(idx)
            planned = next(t for t in cfg['trials'] if t['index'] == idx)
            if planned['target'] != target: raise ValueError('Target differs from plan')
            if d.get('signalIssue'): continue
            phases = [e for e in events if e['type'] == 'gaze_phase' and e['data'].get('phase') == 'control'
                      and e['data'].get('index') == idx and e['perf_ms'] <= result['perf_ms']]
            if len(phases) != 1: continue  # Recentered trials have ambiguous exposure.
            begin = int(phases[0]['eeg']['sampleIndex']) - origin
            end = int(result['eeg']['sampleIndex']) - origin
            if abs((end-begin)/hz - float(d['elapsedSec'])) > .25: continue
            hits = [e for e in events if e['type'] == 'gaze_edge_hit' and e['data'].get('index') == idx]
            if hits: end = min(end, int(hits[0]['eeg']['sampleIndex']) - origin)
            size = round(hz*2)
            for left in range(begin, min(end, begin+round(hz*float(cfg.get('targetSec', 6))))-size+1, size):
                right = left+size
                if left < 0 or right > data.shape[1]: raise ValueError('Trial outside EEG')
                raw = data[:,left:right].copy()
                if not np.isfinite(raw).all(): raise ValueError('Non-finite EEG')
                windows.append(SimpleNamespace(data=raw,sample_rate=hz,channel_names=names,session_id=folder.name,
                    class_id=CLASSES.index(target),trial_index=idx,run=int(planned['run']),start_sample=left,end_sample=right))
        # Last complete trial per direction is held out; all its windows stay together.
        if not closed_training:
            heldout = {max(w.trial_index for w in windows if w.class_id == c) for c in range(len(cfg.get('activeClasses', CLASSES)))}
            for w in windows: w.run = 3 if w.trial_index in heldout else 1
        return windows, cfg['protocol']
    if meta.get('status')!='complete' or meta.get('subjectId')!=subject or cfg.get('mode')!='train':
        raise ValueError('Only completed training recordings from the selected subject are accepted')
    if cfg.get('protocol') not in ('eeg-gaze-v1','gaze-assisted-smr-v1'):
        raise ValueError('Unsupported training protocol')
    hz = float(eeg['sampleRate']); names = tuple(eeg['channelNames'])
    data = load_ct_bin(folder/'eeg.bin',len(names))
    end = int(meta['clock']['sampleIndex']); origin = end-data.shape[1]
    windows=[]; seen=set()
    for event in events:
        if event['type']!='gaze_trial' or event['data'].get('valid') is not True: continue
        d=event['data']; idx=int(d['index']); run=int(d['run']); target=d['target']
        if idx in seen or target not in CLASSES: raise ValueError('Duplicate trial or unknown direction')
        seen.add(idx)
        stop=int(event['eeg']['sampleIndex'])-origin
        duration=float(d.get('elapsedSec',cfg['targetSec']))
        size=round(hz*2)
        for k in range(int((duration+0.001)//2)):
            right=stop-k*size; left=right-size
            if left<0 or right>data.shape[1]: raise ValueError('Trial window outside EEG file')
            raw=data[:,left:right].copy()
            if not np.isfinite(raw).all(): raise ValueError('Non-finite EEG')
            windows.append(SimpleNamespace(data=raw,sample_rate=hz,channel_names=names,session_id=folder.name,
                class_id=CLASSES.index(target),trial_index=idx,run=run))
    return windows,cfg['protocol']

def evaluate(probs,y,windows):
    key=lambda w: (getattr(w,'session_id',''),w.trial_index)
    groups=sorted(set(key(w) for w in windows)); confusion=np.zeros((probs.shape[1],probs.shape[1]),dtype=int)
    for group in groups:
        ids=[i for i,w in enumerate(windows) if key(w)==group]
        assert len(set(y[ids]))==1
        confusion[int(y[ids[0]]),int(probs[ids].mean(0).argmax())]+=1
    counts=confusion.sum(1)
    recalls=[float(confusion[i,i]/counts[i]) if counts[i] else None for i in range(probs.shape[1])]
    return dict(n=len(groups),windows=len(windows),confusion=confusion.tolist(),recalls=recalls,
                balancedAccuracy=float(np.mean(recalls)) if all(r is not None for r in recalls) else None)

def closed_training_protocol(cfg):
    return cfg.get('protocol') == 'gaze-assisted-smr-closed-loop-v1'

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--recordings',type=Path,required=True)
    parser.add_argument('--session',required=True)
    parser.add_argument('--extra-session',action='append',default=[])
    parser.add_argument('--no-activate',action='store_true',help='Archive fitted head without replacing active deployment')
    parser.add_argument('--subject',required=True)
    parser.add_argument('--allow-cued-control', action='store_true', help='Explicit opt-in for offline fitting of labeled feedback control')
    args=parser.parse_args()
    recordings=args.recordings.resolve(); folder=(recordings/args.session).resolve()
    if folder.parent!=recordings: raise ValueError('Session must be directly inside recordings')
    windows,protocol=extract_session(folder,args.subject,args.allow_cued_control)
    events = [json.loads(s) for s in (folder/'events.jsonl').read_text(encoding='utf-8').splitlines() if s.strip()]
    cfg = next(e['data'] for e in events if e['type']=='session_start')
    active_classes = cfg.get('activeClasses', list(CLASSES))
    if active_classes not in (list(CLASSES), ['left','right']): raise ValueError('Unsupported class subset')
    indices = [0,1] if active_classes == ['left','right'] else None
    n_classes = len(active_classes)
    session_names=[folder.name]
    source_protocols=[protocol]
    for name in args.extra_session:
        extra=(recordings/name).resolve()
        if extra.parent != recordings or extra.name in session_names: raise ValueError('Invalid or duplicate extra session')
        other_events=[json.loads(s) for s in (extra/'events.jsonl').read_text(encoding='utf-8').splitlines() if s.strip()]
        other_cfg=next(e['data'] for e in other_events if e['type']=='session_start')
        if other_cfg.get('activeClasses',list(CLASSES)) != active_classes: raise ValueError('Class subsets differ')
        extra_windows,extra_protocol=extract_session(extra,args.subject,args.allow_cued_control)
        if not extra_windows or any(w.channel_names != windows[0].channel_names or w.sample_rate != windows[0].sample_rate for w in extra_windows): raise ValueError('Montage or sample rate differs')
        windows.extend(extra_windows); session_names.append(extra.name); source_protocols.append(extra_protocol)
    if min(Counter(w.class_id for w in windows).get(i,0) for i in range(n_classes))<3:
        raise ValueError('Each direction needs at least three full windows')
    if not any(w.run==3 for w in windows): raise ValueError('Complete all three runs before fitting REVE')
    torch.manual_seed(20260912)
    lora=default_stieger_lora_checkpoint()
    if lora is None: raise ValueError('SMR LoRA is missing')
    backend=ReveModelBackend(model_dir=default_checkpoint_root() / 'reve-base',
        positions_dir=default_checkpoint_root() / 'reve-positions',device='auto',task='gaze_smr',
        strategy='none',lora_checkpoint=lora,cache_size=len(windows)+16)
    backend.load()
    x,y=encode_windows(backend,windows)
    train=[i for i,w in enumerate(windows) if w.run<3]; test=[i for i,w in enumerate(windows) if w.run==3]
    if any(not any(windows[i].class_id==c for i in train) or not any(windows[i].class_id==c for i in test) for c in range(n_classes)):
        raise ValueError('Training and held-out runs must cover all four directions')
    train_linear_head(backend._head,x[train],y[train],epochs=400,lr=0.02,class_indices=indices)
    with torch.no_grad(): probs=backend._head(x[test])[:, :n_classes].softmax(1).cpu().numpy()
    evaluation=evaluate(probs,y[test].cpu().numpy(),[windows[i] for i in test])
    train_linear_head(backend._head,x,y,epochs=400,lr=0.02,reset=True,class_indices=indices)
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    backend.model_revision=f'gaze-smr-lp-{stamp}-{len(windows)}w'
    backend._update_step=400
    out=recordings/'.reve-heads'/'gaze-smr'/stamp; out.mkdir(parents=True)
    saved=out/'head.pt'; save_state(saved,backend)
    report=dict(subjectId=args.subject,session=folder.name,task='gaze_smr',modelRevision=backend.model_revision,
        encoderId=backend.encoder_id,channels=list(windows[0].channel_names),sampleRate=windows[0].sample_rate,
        classNames=list(CLASSES),activeClasses=active_classes,windows=len(windows),trials=len(set((w.session_id,w.trial_index) for w in windows)),
        sessions=session_names,sourceProtocols=source_protocols,
        trainingTrials=[dict(session=s,index=i) for s,i in sorted(set((windows[j].session_id,windows[j].trial_index) for j in train))],
        heldOutTrials=[dict(session=s,index=i) for s,i in sorted(set((windows[j].session_id,windows[j].trial_index) for j in test))],
        sourceProtocol=protocol,bootstrapGazeOnly=protocol=='eeg-gaze-v1',evaluation=evaluation,
        feedbackVisible=bool(cfg.get('predictionVisible', False)),
        evaluationDesign='last whole trial per direction held out; feedback-visible collection, not independent validation' if protocol=='gaze-assisted-smr-control-v1' else 'third run held out; feedback-visible collection' if closed_training_protocol(cfg) else 'third run held out',
        trainingTrialIndices=sorted(set(windows[i].trial_index for i in train)),
        heldOutTrialIndices=sorted(set(windows[i].trial_index for i in test)),
        headPath=str(saved),headSha256=hashlib.sha256(saved.read_bytes()).hexdigest())
    if len(session_names)>1: report['evaluationDesign']='Per-session holdouts: third run for closed-loop training; last trial per direction for control; feedback-visible collection'
    (out/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    if args.no_activate:
        print('RESULT '+json.dumps(report),flush=True)
        return
    active=recordings/'.reve-heads'/'gaze_smr_active.pt'
    shutil.copyfile(saved,active.with_suffix('.tmp')); os.replace(active.with_suffix('.tmp'),active)
    target=recordings/'.reve-heads'/'gaze_smr_active.json'
    target.with_suffix('.tmp').write_text(json.dumps(report,indent=2),encoding='utf-8')
    os.replace(target.with_suffix('.tmp'),target)
    print('RESULT '+json.dumps(report),flush=True)

if __name__=='__main__': main()
