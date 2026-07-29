# Passive BCI 实验网页

三个被动脑机接口（Passive BCI）范式的网页演示。当前阶段用人工评分 / 滑块替代真实 EEG，动画与实验流程完整可跑；日后只需实现新的 `SignalSource`，实验逻辑不用改。

```bash
npm install
npm run dev
```

打开终端提示的本地地址即可。生产构建：`npm run build && npm run preview`。

## 实验一览

| 路径 | 实验 | 脑信号替代 |
|------|------|------------|
| `/#/rl-graph` | 人脑反馈驱动的图上 Q-learning | 按键 1–5 评分 |
| `/#/tetris` | 压力自适应俄罗斯方块 | 主试滑块 / ↑↓ 调压力 |
| `/#/card-cit` | 扑克牌隐藏信息测试（CIT） | 反应时泄漏（空格） |
| `/#/stress-remote` | 压力遥控独立窗口 | BroadcastChannel |

## 实验一 · 人脑反馈强化学习

智能体在节点网络（**图模式** / **网格模式**）上 ε-greedy 探索。终点固定；**每局起点在节点上随机采样**（可选「仅从叶节点度=1 出发」）。每走一步弹出评分窗；**到达终点时自动满分评分**，不再等人。系统用 TD 更新 Q 值：

```
Q(s,a) ← Q(s,a) + α [r_human + r_env + γ max Q(s',·) − Q(s,a)]
```

**操作**

- `1`–`5`：很差 / 较差 / 一般 / 较好 / 很好 → 奖励 `-1 / -0.5 / 0 / +0.5 / +1`（非终点步）
- 侧栏可切图/网格、调节点数与边密度、α/γ/ε、评分超时、起点叶节点限制
- 边的粗细与颜色映射 Q 值；连续 N 局走出**该局**最短路判定收敛
- 导出 JSON / CSV 记录每步评分与局结果

## 实验二 · 压力自适应俄罗斯方块

标准玩法：7-bag、SRS 旋转与踢墙、软降 / 硬降、消行后按列重力下落（可连锁 cascade）、下一块预览、ghost piece。

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
```

## 技术栈

Vite · React 19 · TypeScript · Tailwind CSS v4 · React Router · Recharts
