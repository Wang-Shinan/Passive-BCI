"""Inspect local head metadata without loading full REVE weights."""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch

root, ncc = map(Path, sys.argv[1:3])
items = []
for file in sorted((root / 'recordings' / '.reve-heads').glob('*.pt')):
    item = {'id': file.name, 'name': file.name, 'task': None, 'encoderId': None,
            'classes': None, 'available': False, 'reason': '', 'stateFile': str(file),
            'loraCheckpoint': None, 'size': 'base',
            'updatedAt': datetime.fromtimestamp(file.stat().st_mtime, timezone.utc).isoformat(), 'trainedAt': None}
    try:
        payload = torch.load(file, map_location='cpu', weights_only=True)
        if isinstance(payload.get('trained_at'), str):
            try:
                stamp = datetime.fromisoformat(payload['trained_at'].replace('Z', '+00:00'))
                if stamp.tzinfo is not None:
                    item['trainedAt'] = stamp.isoformat()
            except ValueError:
                pass
        item['modelRevision'] = payload.get('model_revision')
        task = str(payload.get('task', 'passive_rating'))
        encoder = str(payload.get('encoder_id', 'reve-base'))
        weight = payload['head']['weight']
        if weight.ndim != 2:
            raise ValueError('文件不包含二维线性头权重')
        item.update(task=task, encoderId=encoder, classes=int(weight.shape[0]))
        if task == 'smr_control' and payload.get('class_names') != ['left_hand', 'right_hand', 'tongue', 'rest']:
            raise ValueError('旧双手／类别未注明的 SMR 头不适用于舌头四分类，请重新采集并训练')
        if task not in ('smr_control', 'passive_rating', 'tetris_action'):
            raise ValueError('不支持的任务类型')
        if Path(encoder).name != encoder or '/' in encoder or '\\' in encoder or encoder in ('.', '..'):
            raise ValueError('无效的编码器标识')
        if encoder not in ('reve-base', 'reve-large'):
            adapter = Path(payload['lora_checkpoint']) if payload.get('lora_checkpoint') else ncc / 'checkpoints' / 'adapters' / encoder / 'best.pt'
            if adapter.parent.name != encoder:
                raise ValueError('LoRA 路径与编码器标识不一致')
            if not adapter.is_file():
                raise ValueError('缺少配套 LoRA 编码器：' + encoder)
            item['loraCheckpoint'] = str(adapter)
            item['size'] = payload.get('size', 'base')
        else:
            item['size'] = encoder.removeprefix('reve-')
        item['available'] = True
    except Exception as error:
        item['reason'] = str(error)[:400]
    items.append(item)
print(json.dumps(items, ensure_ascii=True))
