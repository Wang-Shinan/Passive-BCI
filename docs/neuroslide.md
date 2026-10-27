# NeuroSlide — BCI Ice Maze

入口：`/#/neuroslide`，也可从首页「SMR」目录进入。复用项目现有 React 19、TypeScript、Vite 和模型运行时，不新增生产依赖，不修改 EEG 训练、标签或推理代码。

## 启动与键盘游玩

在 `Passive-BCI` 目录运行：

```powershell
npm run dev -- --host 127.0.0.1
```

打开 `http://127.0.0.1:5173/#/neuroslide`。本机 Node 未加入 PATH 时可使用工作区已有运行时：

```powershell
cd 'C:\Users\EDY\Desktop\Passive BCI\Passive-BCI'
& '..\.tools\node-v24.21.0-win-x64\node.exe' node_modules\vite\bin\vite.js --host 127.0.0.1
```

选择关卡 → 保持 Keyboard Demo → 点击「开始」 → 按一次方向键。所有输入只有 ↑ ↓ ← →，没有鼠标移动、WASD、路径提示、距离、速度或持续时间控制。长按不重复；松开后再次按下才是新指令。键盘模式不需要 EEG 设备、模型服务或网络。

逻辑位置仅在到达停点后提交。途中经过岔路或终点均不会停下；只有准确停在终点才通关。撞墙指令不移动，但计入操作次数。用时不计暂停时段，无时间惩罚。滑行途中点击暂停会在抵达本次停点后暂停，无法借此改变距离。切换模式/来源同样先结束当前滑行；重新开始、切换关卡会放弃当前局并回到未开始状态。键盘模式失焦请求暂停；BCI 模式允许原生下拉框或其他窗口导致的失焦，只有隐藏页面或手动暂停才停止接收。

默认界面为固定深蓝风格，1920×1080 下收起设置可完整显示，也有全屏按钮及窄屏布局。

## 真实模型类别与映射

已检查这些本地来源：

- `src/experiments/smr-adapt/labels.ts`：`left_hand`, `right_hand`, `tongue`, `rest`。
- `src/lib/model-runtime/reveTasks.ts`：`smr_control` 同上；`gaze_smr` 是 `left`, `right`, `up`, `down`。
- `src/lib/model-runtime/contracts.ts`：`ModelPrediction` 提供 `observation_id`、`class_names`、`probabilities`、`received_at_ms`。
- `bridges/model/README.md`：现有 SMR 四类头的说明与上述一致。

**当前 SMR 没有双脚类，不能把 rest 解释为 feet。** 游戏默认选择「自动匹配模型真实类别」，尚未收到模型标签时使用下列标准 MI 映射；连接当前 SMR 后会明确切换为「休息 → ↓」，不会误称双脚：

| 意图 | 精确标签 | 方向 |
| --- | --- | --- |
| 左手想象 | `left_hand` | ← |
| 右手想象 | `right_hand` | → |
| 双脚想象 | `feet` | ↓ |
| 舌头想象 | `tongue` | ↑ |

展开「BCI 连接与过滤设置」可以选择自动匹配、标准 MI、当前 SMR 预设（**休息 → ↓**）、方向头预设，或逐项填写模型真实标签，例如 `both_feet` 或字符串数字标签。下拉框保留选中项，刷新后也保留；手动选择或编辑的映射不会被模型更新覆盖。自动匹配只识别已知标签集合，未知类别必须手动配置。映射按名称查找概率，支持概率数组顺序变化；四个标签必须互不重复且与实际四类完整匹配，否则拒绝移动。界面显示真实类别和不匹配原因。配置保存在浏览器本地。

## 现有 EEG 服务接入

1. 确认本工作区的 BCIGo 设备已就绪。已有同页采集数据流会直接复用；其他设备可先在「采集调试」连接，再在同一页面导航进入游戏。
2. 进入游戏，选 BCI Mode；预测来源选「现有 EEG 模型服务」。
3. 保持「自动匹配模型真实类别」，或选择与真实 `class_names` 对应的手动预设。当前被试已确认为 **S04**，游戏默认选用 `smr_control_s04_reve_20261015_baseline.pt`。点击「连接模型并开始」时检查并加载该头，校验真实模型版本 `s04-reve-20261015-baseline-b03275ad-4s`，使用其 4 秒输入窗口。不会重新训练或修改权重文件。其他被试可以改选「沿用当前服务 / 项目配置」，在模型配置中选择对应分类头。
4. 按钮连接同源 `/ws/model`，收到四分类握手后复用本页 EEG 数据流；新页面缺少数据流时接入 BCIGo。SDK 直采模型不额外连接 BCIGo。对于运行于其他网站实例的模型，先验证实际版本；不会用 force 接管无关进程。
5. 界面依次显示模型检查、握手、EEG 接入、等待新预测。只有实际收到新预测后才显示「已接入现有模型」并自动开始当前关卡；同时显示实际模型版本、窗口长度、发送窗口数与预测数。数据流或预测超时会给出具体错误。检测到其他页面正在录制时，不抢占 BCIGo。用户取消、暂停或离开页面后，不自动开始。
6. 暂停后点「继续」或右侧「继续脑控」。状态栏明确区分未开始、已暂停、滑行锁定、释放等待和置信度不足，后者显示实际最高概率与阈值。概率面板显示最新四类概率；断线或预测超过 1500ms 未更新时显示等待数据。

`fromModelPrediction()` 以 `observation_id` 为去重身份。`received_at_ms` 使用浏览器 `performance.now()` 时钟。原始持续预测不具备独立试次标识，因此默认使用以下释放再确认机制：

- 显式开始、继续或「连接模型并开始」成功，是新的确认边界：仅接受该边界之后的新预测，首条稳定指令不必先经过低置信度释放；旧消息仍保持去重。
- 每次指令执行之后，先等待释放；换源、改过滤设置也清空已有证据并锁定。
- 连续 3 个**不同消息**的最高概率 ≤ 0.45，释放门控。
- 随后连续 3 个不同消息的同一类别概率 ≥ 0.75，确认一次方向。
- 确认后锁定。即使预测 ID 更新、方向改变或持续高置信度，也不会再移动，直到再次完成释放或收到新独立试次。
- `rest` 若被映射成方向，就是方向类，**不是释放信号**。如果模型始终输出高置信度、没有低置信度间隙，应由上游试次控制器使用下面的独立试次接口，而不是缩短冷却时间来连续触发。
- 阈值、稳定帧数、释放阈值和释放帧数可配置。帧间间隔超过 1500ms 清除稳定证据；过期、乱序、未来时间戳、无效概率和并列最高类别不触发。

## 外部预测 / 独立试次接口

「BCI 连接与过滤设置」中，四个方向各有独立稳定预测调试框，显示当前映射的类别及所需连续预测数（1–30）。未单独调整的类别沿用通用「稳定预测数」；原有 rest 独立值保持不变。独立值按真实类别保存，调整方向映射后随类别移动，刷新后保留。各类别共用置信度阈值，仍须满足释放、去重和独立试次规则。

选择 BCI Mode → 外部独立试次接口 → 开始。上游浏览器桥接器向当前页面发送事件，必须使用同一个页面的单调时间：

```ts
import type { PredictionFrame } from '../src/experiments/neuroslide/bci'

function onEegPrediction(result: {
  observationId: string
  trialId: string
  classNames: string[]
  probabilities: number[]
}) {
  const frame: PredictionFrame = {
    id: result.observationId,        // 一条预测的唯一身份；重传保持同一个 ID
    roundId: result.trialId,         // 一次独立运动想象试次；该试次所有预测共享它
    labels: result.classNames,
    probabilities: result.probabilities,
    receivedAt: performance.now(), // 在桥接器首次收到消息时记录；重传保留原值
  }
  window.dispatchEvent(new CustomEvent('neuroslide:prediction', { detail: frame }))
}
```

该函数由真实模型预测回调调用。不要用定时器重复发送同一预测，不要将每一帧的 observation ID 当作 trial ID。同一 `roundId` 仍需满足稳定确认，且最多执行一次；新的独立 `roundId` 可以再次确认相同方向。**roundId 必须来自采集协议中真实的新试次边界**；持续流没有试次边界时省略它，使用释放门控。

消息身份 `id` 在页面存活期间全局唯一，重开游戏不会清除去重记录。滑行、暂停、未开始、通关、非 BCI 模式期间的预测会被丢弃并记入去重记录；期间出现的整个试次也作废，不允许在滑行结束后补执行。断线重连不得重放旧试次。重新加载页面是新的输入会话，上游也应开启新会话。

这是本页 JS/DOM 适配接口，不是新开的 WebSocket 端点。若模型在 Python/另一进程，继续通过已有模型服务协议/运行时传入持续预测；若需要试次语义，由浏览器桥接器从上游试次协议生成 `PredictionFrame`。项目未包含真实双脚分类头。已于 2026-10-15 在本机通过 BCIGo 32 导、250 Hz → S04 四分类模型 → 过滤器 → 游戏验证真实指令输出（一次向下指令，确认时休息类约 82%）。测试不代表受试者按指定意图控制的准确率已验证。

此前四类长期约 25% 的运行使用的是 Stieger 初始迁移头，而非 S04 个体化模型；同时游戏连接和窗口失焦会使游戏停留在暂停状态。修复改用已确认被试的 S04 权重、4 秒窗口和明确的开始流程，未通过降低到机会水平阈值或放大概率来伪造方向。真实输出仍须满足置信度及稳定性要求。

## 模块与验证

- `src/experiments/neuroslide/engine.ts`：纯网格滑行、计时、暂停、通关和插值。
- `levels.ts`：三张静态地图。
- `input.ts`：键盘边沿检测。
- `bci.ts`：现有模型适配、可配映射、稳定性过滤、去重和试次门控。
- `connection.ts`：模型状态检查、真实 EEG 接入及可取消的握手/新预测就绪检查。
- `index.tsx` / `neuroslide.css`：React 页面和 SVG 冰面。
- `engine.test.ts` / `bci.test.ts` / `levels.test.ts`：规则、输入和可解性测试。
- `tests/neuroslide-smoke.mjs`：真实 Chrome 浏览器验收，三关键盘通关、长按、忙时丢弃、暂停、两种 BCI 接入、大屏与手机布局。

地图测试只在**完整滑行的停点图**上搜索，三关最短路径分别为 5、9、13 次；同时验证每个可达停点都可继续抵达终点，避免不可恢复死局。寻路器仅在测试中，生产游戏没有自动寻路或代操作。

```powershell
npm test -- src/experiments/neuroslide
npm test
npm run build
```

浏览器测试需要可用 Chrome 和 `playwright-core`；它不是游戏运行依赖。本工作区可直接复用已有测试工具（先启动 Vite）：

```powershell
$env:PLAYWRIGHT_PACKAGE_JSON = (Resolve-Path '..\.tools\ui-check\node_modules\playwright-core\package.json').Path
$env:NEUROSLIDE_URL = 'http://127.0.0.1:5173'
& '..\.tools\node-v24.21.0-win-x64\node.exe' tests\neuroslide-smoke.mjs
```

其他环境可在测试环境安装 `playwright-core` 并运行 `node tests/neuroslide-smoke.mjs`，或用 `PLAYWRIGHT_PACKAGE_JSON` 指向已有安装的 `package.json`。`CHROME_PATH` 可指定 Chrome 可执行文件。截图写入 `test-results/neuroslide/`；测试用合成预测验证输入协议与 UI，不代表真实 EEG 分类准确率。

真实设备连接回归为显式开启的 `tests/neuroslide-live-smoke.mjs`，设置 `NEUROSLIDE_LIVE=1` 后运行。该脚本连接实际设备，验证首个预测、自动标签匹配、原生下拉选择和刷新保留；不会注入模拟预测。结果记录在 `test-results/neuroslide/live-connection.json`。不要在其他页面录制期间运行。
