"""Inspect local head metadata without loading full REVE weights."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import torch

root = Path(sys.argv[1]).resolve()
adapters = Path(os.environ.get('REVE_ADAPTER_ROOT', str(root / 'checkpoints' / 'adapters')))
backbones = Path(os.environ.get('REVE_CHECKPOINT_ROOT', str(root / 'checkpoints' / 'backbones')))
items = []
for file in sorted((root / 'recordings' / '.reve-heads').glob('*.pt')):
    item = {'id': file.name, 'name': file.name, 'task': None, 'encoderId': None,
            'classes': None, 'available': False, 'reason': '', 'stateFile': str(file),
            'loraCheckpoint': None, 'modelDir': None, 'size': 'base',
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
        bias = payload['head']['bias']
        if not torch.is_tensor(weight) or not torch.is_tensor(bias) or weight.ndim != 2 or bias.shape != (weight.shape[0],):
            raise ValueError('线性头权重或偏置维度无效')
        if not torch.isfinite(weight).all() or not torch.isfinite(bias).all():
            raise ValueError('线性头包含非有限数值')
        item.update(task=task, encoderId=encoder, classes=int(weight.shape[0]))
        if task == 'smr_control' and payload.get('class_names') != ['left_hand', 'right_hand', 'tongue', 'rest']:
            raise ValueError('旧双手／类别未注明的 SMR 头不适用于舌头四分类，请重新采集并训练')
        if task not in ('smr_control', 'passive_rating', 'tetris_action'):
            raise ValueError('不支持的任务类型')
        if Path(encoder).name != encoder or '/' in encoder or '\\' in encoder or encoder in ('.', '..'):
            raise ValueError('无效的编码器标识')
        backbone_dir = backbones / encoder
        standalone = encoder not in ('reve-base', 'reve-large') and (
            payload.get('full_backbone') is True
            or not payload.get('lora_checkpoint') and (backbone_dir / 'model.safetensors').is_file()
        )
        if standalone:
            if payload.get('lora_checkpoint'):
                raise ValueError('完整主干分类头不能同时指定 LoRA')
            if not all((backbone_dir / name).is_file() for name in ('config.json', 'model.safetensors')):
                raise ValueError('缺少配套完整主干：' + encoder)
            item['modelDir'] = str(backbone_dir)
            item['size'] = 'large' if payload.get('size') == 'large' else 'base'
        elif encoder not in ('reve-base', 'reve-large'):
            recorded = Path(payload['lora_checkpoint']) if payload.get('lora_checkpoint') else None
            # A checkpoint path recorded on another machine is stale; fall back
            # to the local adapters/<encoder>/best.pt convention.
            adapter = recorded if recorded and recorded.parent.name == encoder and recorded.is_file() \
                else adapters / encoder / 'best.pt'
            if adapter.parent.name != encoder:
                raise ValueError('LoRA 路径与编码器标识不一致')
            if not adapter.is_file():
                raise ValueError('缺少配套 LoRA 编码器：' + encoder)
            item['loraCheckpoint'] = str(adapter)
            item['size'] = payload.get('size', 'base')
        else:
            item['size'] = encoder.removeprefix('reve-')
        backbone = (backbone_dir if standalone else backbones / f"reve-{item['size']}") / 'config.json'
        if backbone.is_file():
            embed_dim = json.loads(backbone.read_text(encoding='utf-8')).get('embed_dim')
            if isinstance(embed_dim, int) and weight.shape[1] != embed_dim:
                raise ValueError(f'线性头输入维度 {weight.shape[1]} 与编码器 {embed_dim} 不匹配')
        item['available'] = True
    except Exception as error:
        item['reason'] = str(error)[:400]
    items.append(item)
print(json.dumps(items, ensure_ascii=True))
