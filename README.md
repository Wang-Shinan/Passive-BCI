# Passive-BCI：实验、采集与光标控制

基于 React、TypeScript 和 Vite 的脑机接口实验工作区，提供实验目录、EEG 设备接入、会话录制、SMR 光标控制，以及依赖外部模型后端的 REVE 推理与线性探测入口。

根地址 `/` 直接显示新版目录，支持搜索、分类和亮色／深色切换。目前目录包含 **8 个实验范式、4 个光标控制入口、6 个采集与数据工具**。

> 网页可启动不代表 EEG 或模型服务已经就绪。真实设备采集需要设备桥接及相应驱动；REVE 推理和训练仍依赖兼容版本的外部 `NCC-OI-BCI`。本文末尾的自动采集与微调流程是规划，尚未实现。

## 快速启动

Windows 双击桌面「開啟 Passive BCI.cmd」打开；关闭后台服务使用工作区的 `Close Passive BCI.cmd`（或桌面同名关闭入口）。关掉浏览器标签页不会退出后台网站。

也可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/stop-local.ps1`。关闭时先停止本项目托管的模型和设备桥接，再保存服务端已收到的录制数据，最后关闭经过路径核验的本项目网站进程。未从采集页正常停止的录制标记为 `interrupted`，保留数据；浏览器尚未发送的数据无法恢复。若保存失败，保留网站运行。加 `-ServicesOnly` 可停止采集和模型、保留网站。

打开网页不再依赖模型启动成功；有录制时跳过自动加载模型，仍可进入网页停止录制。`scripts/open-website.ps1 -NoModel` 只打开网站。

准备 Git，以及符合当前 Vite 要求的 Node.js：`20.19+`（20.x）或 `22.12+`，附带 npm。依赖版本以 `package-lock.json` 为准。

```sh
git clone https://github.com/Wang-Shinan/Passive-BCI.git
cd Passive-BCI
npm ci
npm run dev -- --host 127.0.0.1
```

打开终端显示的地址，通常为 `http://127.0.0.1:5173/`。端口占用时以实际输出为准。上述命令也可在 Windows PowerShell 中执行。

无需连接 EEG 即可浏览目录，并使用支持键盘、手动信号或演示数据的实验。需要真实 EEG 或指定模型的任务，其要求在入口卡片和任务页面中说明。

### 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev -- --host 127.0.0.1` | 本地工作区，包含 Vite 开发服务提供的采集、模型管理、录制和训练 API |
| `npm run build` | TypeScript 检查并构建前端到 `dist/` |
| `npm run preview` | 预览前端构建产物，不提供完整采集后端 |
| `npm test` | 运行 Vitest 测试 |
| `npm run lint` | 运行 Oxlint |
| `npm run dev:preview` | 兼容的预览工作区，固定端口 5174；新版目录位于 `/preview.html` |
| `npm run build:preview` | 构建包含两个 HTML 入口的版本到 `dist-preview/` |

`preview.html` 保留独立入口，禁用 App 的模型自动启动选项；正式根入口保留原有任务启动行为。两者复用实验路由。日常使用直接打开 `/` 即可。

**真实采集目前应使用 `npm run dev`。** 单独托管 `dist/` 或运行 `vite preview` 不会提供开发插件中的录制、训练和服务管理 API；生产部署还需要独立后端。

### Node 25 测试兼容性

本地 Node 25.9.0 下，直接运行 `npm test` 会因 Node 的 Web Storage 行为在导入模型模块时出现 `localStorage.getItem is not a function`。可仅为测试进程禁用该功能，包含其子进程：

```sh
# macOS / Linux
NODE_OPTIONS=--no-experimental-webstorage npm test
```

```powershell
# Windows PowerShell：临时设置并恢复原值
$previousNodeOptions = $env:NODE_OPTIONS
try {
  $env:NODE_OPTIONS = "$previousNodeOptions --no-experimental-webstorage".Trim()
  npm test
} finally {
  $env:NODE_OPTIONS = $previousNodeOptions
}
```

本次在 macOS Node 25.9.0 上使用该设置，42 个测试文件、197 个测试通过；这不代表 Windows GPU 或真实设备链路已验证。

## 页面入口

使用 Hash 路由。例如 N-back 的地址是 `http://127.0.0.1:5173/#/nback`。

### 实验范式

| 路由 | 实验 | 主要操作与用途 |
| --- | --- | --- |
| `/#/nback` | N-back 工作记忆 | 1–3-back 字母匹配，空格响应，行为日志及 EEG 同步录制 |
| `/#/tetris` | 压力自适应俄罗斯方块 | 键盘操作、压力调速、按局录制；脑控需要 EEG 和模型 |
| `/#/rl-graph` | 人脑反馈强化学习 | TAMER、Q-learning、AI 分配 Q；按键 1–5 评分 |
| `/#/card-cit` | 扑克牌隐藏信息测试 | 心选牌、随机闪动与空格响应；当前判断基于反应时 |
| `/#/jump` | 跳一跳 | 按压蓄力、松开跳跃，记录操作和结果 |
| `/#/draw-guess` | 你画我猜 | 手绘、AI 猜测、情感评分；远端视觉模型需配置 API |
| `/#/dino` | 小恐龙 | 跳跃／俯身，压力信号调节速度和障碍 |
| `/#/schulte` | 舒尔特方格 | 按序点击数字，记录反应时 |

### 光标控制

| 路由 | 入口 | 条件 |
| --- | --- | --- |
| `/#/smr` | SMR 采集与光标控制 | 普通／全屏 SMR；全屏采集需要真实 EEG 和对应模型 |
| `/#/smr-acquisition` | SMR 分组采集与训练 | 四方向分组、组间自动 probing 与模型选择；自动训练需要真实 EEG 和本地冻结 REVE 四分类模型 |
| `/#/tetris-adapt` | 方块 SMR 适配 | 动作练习与窄井任务，脚想象只采标签；现有四分类头保持冻结 |
| `/#/gaze-smr-tetris` | 全屏 SMR 俄罗斯方块 | 真实 EEG 与本被试匹配的 `gaze_smr` 模型头 |

「SMR 上下控制」与「眼动版俄罗斯方块（旧 LDA）」已从目录移除；底层实现和 `/#/smr-ud`、`/#/gaze-tetris` 旧路由暂时保留。

### 采集与数据工具

| 路由 | 用途 |
| --- | --- |
| `/#/acquisition` | 设备连接、开流、波形、频谱、阻抗和通道配置 |
| `/#/jaw-clench` | 提示式咬牙／放松 EEG 二分类采集；独立全屏入口，无需模型 |
| `/#/recordings` | 浏览本地会话，编辑备注、下载和删除 |
| `/#/training` | SMR 数据导出 H5、冻结 REVE 的 linear probing、查看训练结果 |
| `/#/online-learn` | REVE 任务与在线线性头配置；SMR 头保持冻结 |
| `/#/stress-remote` | 实验员独立压力调节窗口 |

## 真实 EEG 采集

咬牙采集：先在「采集调试」连接并开流，再进入「咬牙与放松采集」（`/#/jaw-clench`）。在右上角「实验员设置」填写被试编号、设置试次数和时长，返回被试画面后开始。默认 20 次、两类各 10 次，短区块内均衡随机；每次准备 2 秒 → 动作缓冲 1 秒 → 有效采集 2 秒 → 放松休息 3 秒。无设备时可预览，预览不录制、不写事件。

该流程复用录制器，将原始 EEG 与事件写入独立 `jaw-clench` 会话。标签 `relax=0`、`clench=1` 来自指令（`labelSource=instruction`，`observedClench=null`），不代表传感器已确认实际动作。仅有效采集阶段生成 `jaw_trial`，准备／缓冲／恢复不作为负样本；`jaw_phase` 记录阶段、提示标签、时长和时间边界。实验员可在有效采集结束前按 **X** 标记当前试次无效。Esc、退出全屏、页面隐藏、计时或 EEG 中断会停止并保存；未完成试次标为无效，会话写入 `session_abort`，已完成片段保留。

`jaw_trial.data` 包含 `trialIndex`、`label`、`classId`、`valid`、`invalidReason`、`collectStartPerfMs`／`collectEndPerfMs`、`sampleStart`／`sampleEnd`。样本区间是采样时钟估计的流内半开区间 `[sampleStart, sampleEnd)`，不是 BIN 文件内偏移；离线提取需结合 `eeg.json`、`eeg.idx.json` 和实际录制长度对齐并检查边界。模型训练／二分类窗口导出尚未接入此入口，勿把这些会话送入现有 SMR 四分类训练流程。已用模拟 EEG 批次和拦截的落盘接口验证标记、字节数与中止保存；真实设备和动作质量仍需现场验证。

1. 安装所用设备的驱动／采集软件，按桥接文档配置 Python 依赖和数据转发。
2. 启动本地工作区，进入「采集调试」，连接设备并点击「开始采集」。
3. 检查实时波形、通道和采样率；进入对应实验，选择实时 EEG。
4. 按实验页面的录制流程操作。例如俄罗斯方块在实验页使用「开始本局／结束本局」。
5. 结束后进入「会话库」，检查会话信息与数据，再下载或用于训练。

设备接入文档：

- [OmniBCI LSL 桥接](bridges/omni/README.md)
- [Neuracle／博睿康桥接](bridges/neuracle/README.md)
- [BrainCo BCIGo 桥接](bridges/bcigo/README.md)

录制服务在项目根目录 `recordings/<会话目录>/` 保存文件，包括 `session.json`、`eeg.bin`、`eeg.json`、`eeg.idx.json`、`events.jsonl` 和 `context.jsonl`。具体内容取决于实验和录制状态。

`recordings/` 已被 Git 忽略；克隆仓库不会带来历史被试数据或该目录内的模型头。数据备份需单独安排。设备开流、游戏运行与会话成功保存是不同状态，应分别确认。

## 模型服务与训练依赖

### 当前结构

```text
浏览器实验与采集界面
  ├─ EEG 桥接：设备数据 → WebSocket
  ├─ Vite 本地 API：会话写入、训练任务、服务启动管理
  └─ NCC-OI-BCI：REVE 推理、特征提取和训练依赖
```

模型 WebSocket 默认地址为 `ws://127.0.0.1:8768/v1/model`。输入窗长以服务端 `hello` 协议为准；REVE 当前使用 2 秒窗。预处理、通道、采样率、encoder／LoRA 和分类头必须匹配。协议和任务配置见 [模型接入文档](bridges/model/README.md)。

启动器会查找环境变量 `NCC_OI_BCI_ROOT`，然后查找相邻目录及用户 Desktop／Documents 下的 `NCC-OI-BCI`。Python 优先使用 `NCC_PYTHON`，其次查找 NCC 的 `.venv` 和 `bci-dayloop` Conda 环境。

新主机应显式指定路径，避免选错环境。Windows PowerShell 示例（请替换为实际路径）：

```powershell
$env:NCC_OI_BCI_ROOT = 'D:\BCI\NCC-OI-BCI'
$env:NCC_PYTHON = 'D:\BCI\NCC-OI-BCI\.venv\Scripts\python.exe'
$env:MODEL_DEVICE = 'cuda'
npm run model-service:reve:smr
```

如果通过网页启动服务，应先在同一个 PowerShell 中设置环境变量，再执行 `npm run dev`。上述配置不会自动安装 Python 依赖或下载模型权重。

所选 NCC 版本必须包含对应脚本，例如 `scripts/serve_reve_model.py`、`scripts/fit_smr_control_head.py`，以及训练入口依赖的 `bci_dayloop` 模块。仅有名为 NCC-OI-BCI 的目录不足以保证兼容。

| 命令 | 用途 |
| --- | --- |
| `npm run model-service:reve` | REVE 默认任务服务 |
| `npm run model-service:reve:smr` | `smr_control` 任务服务 |
| `npm run model-service:reve:tetris` | `tetris_action` 任务服务 |
| `npm run model-service:mock` | 模拟模型协议，仍需要 NCC 中的 mock 服务脚本 |
| `npm run model-service:reve:smr:export` | 调用外部后端导出 SMR 数据 |
| `npm run model-service:reve:smr:fit` | 调用外部后端拟合 SMR 分类头 |

当前 SMR 默认配置仍引用特定历史被试的模型头和适配器。新主机须提供对应文件或显式指定经过验证的配置；不能把该默认值直接当作新被试的通用模型。模型头及其报告、LoRA 和基座需要成套迁移。

### Windows 与 RTX 5060

RTX 5060 属于 Blackwell（compute capability 12.0），桌面版标准显存为 8 GB。PyTorch 2.7 开始引入 Blackwell／CUDA 12.8 支持，官方提供 Windows CUDA 12.8 安装包。旧的 PyTorch 2.0.1 + CUDA 11.8 环境不应作为该卡的部署基线。

- [NVIDIA RTX 5060 官方规格](https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5060-family/)
- [PyTorch Blackwell 支持说明](https://pytorch.org/blog/pytorch-2-7/)
- [PyTorch 各版本 Windows 安装组合](https://pytorch.org/get-started/previous-versions/)

这些是硬件和框架的支持条件，不代表本项目已经通过 5060 实机验证。本仓库目前没有锁定并验证完整的 Windows GPU 后端环境。部署需同时验证驱动、PyTorch CUDA 构建、模型算子、权重加载、推理延迟、linear probing 和 LoRA 显存占用；仅能识别 GPU 或打开网页不足以证明整套流程可用。

部分辅助 npm 脚本使用 Bash，不能直接视为 Windows 原生命令。设备依赖按各桥接文档配置。

## 规划：俄罗斯方块采集与自适应微调

### 本地开发进度：分组采集原型

实验目录新增独立入口「SMR 分组采集与训练」（`/#/smr-acquisition`），默认使用四方向分组、REVE 四分类与自动 probing。每组四方向等量打乱，支持配置组数及每组试次数（4 的倍数），组间保存、训练并评估模型，模型就绪后手动继续。使用左手／右手／舌头／休息映射（上方提示舌头运动想象，不实际动作）；旧双手数据与分类头不改标复用，需要重新采集训练并重启模型服务；默认 3 组 × 20 次为试运行值，不是正式实验参数。普通 SMR 页面保留原有适配计划。无 EEG 时可演示，但不会保存 EEG 或训练；断流、页面隐藏或手动终止会记录中断。

首版复用现有 Vite API、录制器和 Python 训练脚本，包含固定试次划分、组文件校验、均衡 probing、候选比较、组间切换与失败回退。轮末默认汇集同被试兼容历史数据，联合训练 LoRA 与分类头，继承已有试次划分并保留全部验证／测试数据；候选达标且载入检查通过后供下一轮使用。参数在「实验员设置」调整，被试只看任务和休息画面。写入失败或字节数不符的会话标记为中断，不进入自动训练。真实 EEG 多轮闭环、异常重启恢复、完整信号质量筛选与全部历史版本重新评选仍待验证或实现，具体边界见[方案文档](docs/tetris-acquisition-finetuning-proposal.md)。

轮末 LoRA 已在 RTX 5060 上使用真实 REVE-base 和合成 EEG 完成两次连续训练与产物重载检查（包含从上一 adapter 继续训练），重载 logits 一致，测试试次未进入训练或评估。可用 `python scripts/smoke-round-lora.py --ncc ../NCC-OI-BCI --output test-results/round-lora-check` 复现；该检查不启动在线服务或发布被试模型。

本机已接入同级 `NCC-OI-BCI` 的 `mystery@9fae013`，下载官方 REVE-base 与位置库，并在 RTX 5060 / torch 2.7.1+cu128 上通过真实基座推理、合成数据线性头更新和最小 LoRA 单步验证。WebSocket 直连与 Vite 代理均通过。2026-10-11 已部署用户指定的 `stieger2021_4class_reve_lora_r16_mi5init/best.pt`，同时加载 LoRA 和其内置四分类头。重启工作区运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-local.ps1`，然后在普通 SMR 页启动模型；加 `-Bootstrap` 可回到未训练基座验收模式。当前 serving 为 2 秒、200 Hz、400 点输入，checkpoint 记录训练输入 800 点，真实 EEG 效果与训练／推理输入一致性尚待验证。完整环境与校验记录在同级 NCC 仓库的 `docs/windows-reve.md`。

**以下为完整目标流程：组间 probing、轮末 LoRA、评估与接管已接入首版；全部历史保留版本在统一快照上的 best 评选尚未接入。**

已确定的方向：

1. 第一轮沿用 SMR 判定逻辑控制光标；上、下、左、右在同一阶段随机呈现，不拆成先左右、再上下。
2. 在每个采集组的休息点保存数据，并进行样本均衡的 linear probing。
3. 对候选模型进行评估；性能更好才接管后续采集，切换安排在组间。
4. 每轮结束后，利用历史各轮累积数据进行 LoRA。
5. 后续每轮从历史 best model 开始采集，并记录各组实际使用的模型版本。

当前采用整试次固定划分，休息期间串行训练并释放推理模型，LoRA 从当前模型初始化。每组试次数、休息时长、接管门槛与训练超参数仍需通过先导实验固定。预留验证数据保持独立，不参与训练；历史数据累积不等于将验证样本也用于训练。

部署方向是把采集所需的推理、linear probing、LoRA 和模型版本管理整理为可独立安装的 Windows 后端，配合完整模型包，减少对研究仓库目录和个人环境的依赖。该打包工作及真实 EEG 多轮现场验收尚未完成。

## 代码导航

| 路径 | 内容 |
| --- | --- |
| `src/main.tsx`、`src/App.tsx` | 正式入口、诊断与实验路由 |
| `src/preview/` | 正式首页复用的新版目录、入口数据、主题；目录名称保留历史命名 |
| `src/experiments/` | 各实验与 SMR 任务 |
| `src/acquisition/`、`src/recordings/`、`src/training/` | 采集、会话库和训练页面 |
| `src/lib/eeg/`、`src/lib/model-runtime/`、`src/lib/session/` | EEG、模型运行时及会话逻辑 |
| `bridges/` | 设备桥接和模型协议文档 |
| `scripts/` | 模型启动、数据导出和训练适配脚本 |
| `vite.*.ts` | 本地服务 API、录制与服务进程管理，以及对应测试 |
| `passive-bci-oracle-eval/`、`offline-svm/`、`tetris-rl/` | 独立评估与实验子项目，各有额外依赖 |
