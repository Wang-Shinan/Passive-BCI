# Tetris RL — 多算法训练（可拉到 H20 上跑）

Python 子项目：同一套环境上扫 **BC / Double-Dueling DQN / PPO / BC→PPO**，导出 ONNX 给浏览器加载。

现有单环境 DQN 在 8 万步评估上消行仍是 0。启发式能消行，所以服务器默认会先跑行为克隆，再对比纯 RL。

## 服务器（H20）

```bash
git pull
cd tetris-rl

# 若本机 pip 的 torch 不是 CUDA 版：
#   export TORCH_INDEX_URL=https://download.pytorch.org/whl/cu124

chmod +x scripts/run_server.sh
./scripts/run_server.sh                 # 依次跑 configs/sweep_h20.json
./scripts/run_server.sh configs/ppo_h20.json
./scripts/run_server.sh --smoke         # 四种算法各跑一小段，确认环境
```

建议用 tmux/screen，日志在 `runs/<name>/metrics.jsonl`。Ctrl+C 会存 `ckpt/latest.pt`。

```bash
# 只跑一种
python -m tetris_rl train --config configs/bc_h20.json
python -m tetris_rl train --config configs/dqn_h20.json --precision bf16
python -m tetris_rl train --config configs/ppo_h20.json
python -m tetris_rl train --config configs/bc_ppo_h20.json

# 断点续训
python -m tetris_rl train --config configs/ppo_h20.json --resume runs/ppo_h20/ckpt/latest.pt

# 评估 / 导出到前端
python -m tetris_rl eval --checkpoint runs/bc_h20/ckpt/latest.pt
python -m tetris_rl export --checkpoint runs/bc_h20/ckpt/latest.pt --out-dir ../public/models/tetris-rl
```

H20 配置用 `bf16`、几十个并行环境、大批次。成功与否看 `summary.json` 里的 `final_eval.mean_lines`，并和同一次跑的 `baselines.heuristic` / `baselines.random` 比，不要只看进程退出码。

## 本地

```bash
cd tetris-rl
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

python -m tetris_rl train --algo dqn --smoke
PYTHONPATH=. pytest -q
python scripts/verify_parity.py
```

## 算法

| 名字 | 做什么 |
| --- | --- |
| `bc` | 克隆启发式落子（强基线，通常能消行） |
| `dqn` | Double + Dueling + n-step，可混入启发式动作 |
| `ppo` | 向量环境 on-policy |
| `bc_ppo` | 先 BC 再 PPO 微调 |

动作空间不变：`noop | left | right | rotateCW | rotateCCW | softDrop | hardDrop`，每 100ms 一步。ONNX 仍是 `observation → q_values`（PPO/BC 导出的是 logits，浏览器照样 argmax）。

## 目录

```
configs/           # H20 扫描与单算法配置
tetris_rl/
  algos/           # dqn / ppo / bc
  run.py           # 训练循环、checkpoint、SIGTERM
  cli.py
scripts/run_server.sh
runs/<name>/       # 日志与权重（gitignore）
```
