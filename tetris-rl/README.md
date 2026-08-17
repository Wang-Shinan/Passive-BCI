# Tetris RL — 本地 DQN 训练

Python 子项目：训练自主玩俄罗斯方块的 DQN，并导出 ONNX 供浏览器加载。

## 快速开始

```bash
cd tetris-rl
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# 验证与 TypeScript 引擎一致
python scripts/verify_parity.py

# 短 smoke 训练
python scripts/train.py --smoke

# 正式训练（约 15 万步，CPU 数分钟）
python scripts/train.py --steps 150000

# 评估
python scripts/evaluate.py --checkpoint checkpoints/dqn_latest.pt

# 导出 ONNX 到 public/models/tetris-rl/
python scripts/export_onnx.py --checkpoint checkpoints/dqn_latest.pt
```

## 与前端集成

1. 导出后访问 Tetris 实验页，打开 **RL Agent** 面板。
2. 勾选「启用 AI 代打」，模型从 `/models/tetris-rl/tetris-dqn.onnx` 加载。
3. AI 与键盘/MI 控制互斥；关闭后恢复人工操作。

## 动作空间

`noop | left | right | rotateCW | rotateCCW | softDrop | hardDrop`

每 **100ms** 决策一次，与训练环境 `RL_DECISION_DT_SEC=0.1` 对齐。

## 目录

```
tetris_rl/
  engine.py      # 与 src/experiments/tetris/engine.ts 对齐
  env.py         # Gymnasium 环境
  model.py       # CNN DQN
  agent.py       # 训练逻辑
fixtures/
  parity_trajectories.json
scripts/
  train.py
  evaluate.py
  export_onnx.py
  verify_parity.py
```
