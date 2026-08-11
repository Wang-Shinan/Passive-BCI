# Passive BCI 实验网页

六个被动脑机接口（Passive BCI）范式的网页演示。当前阶段用人工评分 / 滑块替代真实 EEG，动画与实验流程完整可跑；日后只需实现新的 `SignalSource`，实验逻辑不用改。

```bash
npm install
npm run dev
```

打开终端提示的本地地址即可。生产构建：`npm run build && npm run preview`。

## 实验一览

| 路径 | 实验 | 脑信号替代 |
|------|------|------------|
| `/#/rl-graph` | 人脑反馈驱动的图上强化学习（TAMER / Q / AI 分配 Q） | 按键 1–5 评分 + 可选文字 |
| `/#/tetris` | 压力自适应俄罗斯方块 | 主试滑块 / ↑↓ 调压力 |
| `/#/card-cit` | 扑克牌隐藏信息测试（CIT） | 反应时泄漏（空格） |
| `/#/jump` | 跳一跳 | 按压蓄力 + 压力滑块 |
| `/#/draw-guess` | 你画我猜（AI 猜图） | 四维情感滑块 + 文字反馈 |
| `/#/dino` | 小恐龙跑酷 | 主试滑块 / 1–5 调压力 |
| `/#/stress-remote` | 压力遥控独立窗口 | BroadcastChannel |

## 实验一 · 人脑反馈强化学习

智能体在节点网络（**图模式** / **网格模式**）上探索。可选三种价值更新：

- **TAMER**：`Ĥ(s,a) ← Ĥ + α·w·(f − Ĥ)`，用人评分直接监督，无 γ bootstrap；可选信用窗口把反馈分摊到最近几步
- **Q-learning**：`Q ← Q + α[r_human + r_env + γ max Q′ − Q]`
- **AI 分配 Q**：把评分 + 可选文字反馈发给 LLM；模型可见本步局部 Q 候选（刚执行、同状态兄弟、信用窗口内更早步），**不可见完整图/坐标/终点位置**，直接写出各候选新 Q

终点固定；**每局起点随机**（可选仅叶节点）。到达终点自动满分评分。

## 实验二 · 压力自适应俄罗斯方块

标准玩法：7-bag、SRS 旋转与踢墙、软降 / 硬降、消行闪烁 + 上方色块按列独立下落（可连锁）、下一块预览、ghost piece。

**操作（被试）**

- `←` `→` 移动 · `↑` / `X` 顺时针 · `Z` 逆时针 · `↓` 软降 · `空格` 硬降 · `P` 暂停 · `R` 重开

**操作（主试）**

- 右侧压力滑块，或 `↑` `↓`（Shift 加速）
- 「打开独立压力窗口」→ `/#/stress-remote`，避免被试看到调节

**映射模式**

- **挑战模式（默认）**：压力越高下落越快；方块按亚格子**连续平滑下落**
- **调节模式**：PI 控制器把压力拉向设定点——压力偏高则降速，偏低则加速

实时双轴曲线记录压力与重力（格/秒）。

## 实验三 · 扑克牌 CIT

用反应时泄漏替代 P300，不接 EEG 也能做「欺骗」博弈。

1. **识记**：展示一手牌；被试心选一张写在纸上（页面不记录）
2. **闪动**：三轮，每张牌随机顺序各闪一次；每次高亮按 `空格` 表示「不是我的牌」
3. **猜测**：系统对每张牌取有效 RT 中位数，被试内 z-score，取 z 最大者为猜测
4. **反馈**：被试只点「对 / 错」，系统只记这一个 bit

计时：闪动 onset 用双 rAF + `performance.now()`；按键用 `KeyboardEvent.timeStamp`。超时 / 漏按记为无效试次，抑制「整体变慢」策略。

## 实验四 · 跳一跳

复刻微信「跳一跳」核心玩法；物理与计分对齐 [yaoshanliang/weapp-jump](https://github.com/yaoshanliang/weapp-jump)。

- 按住蓄力：`vz = min(t·70, 150)`，`vy = min(135 + t·15, 180)`（t 为秒），松手后按重力 `720` 抛物线飞行。
- 落在下一台 +1；中心完美落地连击倍率 `2 → 4 → 6 … ≤ 32`。
- 分数升高后面台半径缩小、最大台距增大（原版难度递增）。
- 压力滑块经 `ManualSignalSource` 注入，调节台距与台面大小。
- 蓄力、起跳、落地、完美连击、掉落事件可导出。

## 实验五 · 你画我猜

参考 [微信小程序你画我猜](https://github.com/Data-Camp/WeApp_Demos/tree/master/%E4%BD%A0%E7%94%BB%E6%88%91%E7%8C%9C/wxa_drawguess-master) 的画板玩法，改成「人对 AI」单人范式。

- 每轮给出一个词语，被试在白板上手绘（颜色 / 粗细 / 撤销 / 清空）。
- 「让 AI 猜」：默认本地演示猜测；也可在页面配置 OpenAI 兼容 Vision Chat Completions（密钥仅存 localStorage）。
- 右侧四维信号滑块：满意度、惊讶度、专注度、活跃度（各一路 `ManualSignalSource`）。
- 文字反馈框可自由描述体验；笔画、猜测、信号与反馈均可导出。

## 实验六 · 小恐龙

Chrome 离线小恐龙风格跑酷：

- 空格 / ↑ / 点击跳跃；↓ 俯身躲飞鸟；P 暂停。
- 仙人掌与飞鸟障碍；分数随距离增加，高分段昼夜切换。
- 压力滑块 / 按键 1–5：速度 ×0.82–1.55，障碍间隔 ×1.35–0.62，飞鸟概率随压力升高。
- 起跳、俯身、碰撞、结算事件可导出。

## 接入真 BCI

核心接口在 [`src/lib/signal/types.ts`](src/lib/signal/types.ts)：

```ts
interface SignalSource {
  readonly id: string
  readonly kind: SignalKind  // 'rating' | 'stress' | 'generic'
  latest(): SignalSample | null
  subscribe(listener: SignalListener): () => void
  start?(): void
  stop?(): void
}
```

当前实现：[`ManualSignalSource`](src/lib/signal/manual.ts)（键盘 / 滑块）。

日后例如：

1. 用 Python 把 LSL EEG 流解算出满意度 / 压力 / P300 分数
2. 经 WebSocket 推到浏览器
3. 新建 `LslBridgeSignalSource implements SignalSource`，在实验入口替换 `ManualSignalSource`

实验一 / 二已经通过 `ManualSignalSource.push(...)` 写入评分与压力，订阅点可直接换源。

## 目录

```
src/
  lib/signal/     SignalSource 抽象与人工源
  lib/logger.ts   SessionLogger（JSON/CSV）
  lib/rng.ts      种子 RNG / 统计工具
  lib/timing.ts   双 rAF 校准时刻
  experiments/
    rl-graph/     实验一
    tetris/       实验二
    card-cit/     实验三
    jump/         实验四
    draw-guess/   实验五
    dino/         实验六
```

## 技术栈

Vite · React 19 · TypeScript · Tailwind CSS v4 · React Router · Recharts

## 离线评估

最短路 oracle × 噪声梯度 × Q vs TAMER 的离线实验在本仓库子目录：

[`passive-bci-oracle-eval/`](./passive-bci-oracle-eval)
