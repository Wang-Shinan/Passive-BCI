# Passive BCI — Oracle Path Evaluation

本仓库子目录：用**最短路进展**当作「理想脑反馈」，在加/不加噪声、噪声梯度下对比 **Q-learning** 与 **TAMER**，估计真实解码器能容忍多大失误。

对应网页 demo：仓库根目录 [`../`](../) 实验一（`/#/rl-graph`）。

## 设定

| 项目 | 内容 |
|------|------|
| 环境 | 6×5 网格（默认）或随机连通图 |
| Oracle 评分 | 动作使到终点 BFS 距离 ↓ → `+1`；不变 → `0`；↑ → `-1` |
| 终点 | 额外自动 `+1`（与网页一致） |
| 无反馈 | 解码 miss / 超时 → **不更新**价值表 |
| 噪声 | 高斯 σ + 可选离散等级翻转 + miss 概率 |
| 指标 | 最终贪心动作与最优动作一致率；近 20 局成功率；超额步数；收敛局数 |

## 快速开始

```bash
cd passive-bci-oracle-eval
pip install -r requirements.txt

# 主扫描：高斯噪声梯度 × 两种算法
python scripts/run_sweep.py --episodes 200 --seeds 8

# 离散翻转扫描（固定轻度 σ）
python scripts/run_flip_sweep.py --episodes 200 --seeds 8 --sigma 0.2

# 奖励来源对照：oracle vs 随机+保留终点 vs 完全随机
python scripts/run_random_reward.py --episodes 200 --seeds 12

# 更难：随机图 + 翻转 + miss
python scripts/run_sweep.py --graph-mode graph --nodes 30 \
  --sigmas "0,0.2,0.4,0.6,0.8,1.0" --flip-prob 0.1 --miss-prob 0.1 \
  --out results/hard --figures figures/hard
```

结果：

- `results/noise_sweep_summary.csv`
- `figures/opt_ratio_vs_sigma.png`
- `figures/success_vs_sigma.png`
- `figures/learning_curves.png`
- `figures/converge_vs_sigma.png`
- `figures/opt_ratio_vs_flip.png`
- `figures/success_vs_flip.png`
- `figures/learning_curves_vs_flip.png` — **每个 flip 水平一张完整 excess 学习曲线**
- `figures/learning_curves_flip_overlay.png` — 同图叠加所有 flip
- `figures/success_curves_vs_flip.png` — 逐局成功率曲线
- `results/flip_learning_curves.json` — 原始逐局曲线数据
- `figures/learning_curves_random_reward.png` — oracle / 随机+保留终点 / 完全随机
- `figures/opt_ratio_vs_reward_mode.png`
- `results/random_reward_summary.csv`
## 已跑通的结论（本机一次复现）

### 1) 6×5 网格，仅高斯噪声

两种算法都极稳：σ 到 **0.8** 时近 20 局成功率仍 ≈1，最优动作一致率 ≳0.95。  
原因：任务短、oracle 标签极性强（±1），高斯扰动很少改变「好/坏」符号。

### 2) 离散翻转（σ=0.15 固定）— 看完整曲线

成功率曲线几乎立刻到 1（任务太短，终点可达性不敏感）。**真正拉开差距的是 excess-steps 学习曲线**：

| flip | Q 最终 opt | TAMER 最终 opt | 曲线形态 |
|------|------------|----------------|----------|
| 0–0.1 | ≳0.96 | ≈1.00 | 两者都快速降 excess |
| 0.2 | ~0.96 | ~0.99 | Q 中段抖动；TAMER 仍平滑 |
| 0.3–0.4 | ~0.91–0.93 | ~0.98–0.99 | Q 全程尖峰；TAMER 明显更稳 |

**TAMER 对「符号翻错」更稳**；看 `learning_curves_vs_flip.png` / `learning_curves_flip_overlay.png`。

### 3) 更难：30 节点随机图 + flip 0.1 + miss 0.1

- Q：最优一致率大约 **0.76–0.80**
- TAMER：大约 **0.81–0.93**，收敛往往更快

### 实践建议（解码器容错）

在本设定下（路径进展式满意度）：

1. **纯幅度噪声（高斯）**：σ ≲ **0.4–0.5**（相对 ±1 标签）对两种算法都可接受；网格任务可更高。
2. **类别翻错**更伤：建议解码器把「好/坏」极性搞反的概率压到 **≲10–15%**；到 30–40% 时 Q 明显吃亏，TAMER 仍可用但质量下降。
3. **漏检/超时**（不更新）优于「乱给 0 分硬更新」——与网页改动一致。
4. 若真实 ErrP/满意度解码更接近「极性分类」而非精细回归，优先保证 **极性准确率**，再追求幅度精度。

> 注意：这是 tabular、小图、oracle=最短路进展的仿真，不是真实 EEG。换特征、图规模或反馈定义后，阈值会变；把本仓库当校准脚手架即可。

## 代码结构

```
oracle_eval/
  graph.py      # 网格 / 随机图 + BFS
  oracle.py     # 最短路评分 + 噪声
  learners.py   # Q-learning / TAMER
  train.py      # 训练循环与指标
scripts/
  run_sweep.py
  run_flip_sweep.py
```

## 与网页 demo 的对应

| 网页 | 本仓库 |
|------|--------|
| 人工 1–5 评分 | Oracle ±1/0 |
| 评分噪声开关 | `--sigmas` / `--flip-prob` |
| 超时不更新 | `--miss-prob` → skip update |
| TAMER / Q 切换 | `--` 扫描两种 `algo` |
