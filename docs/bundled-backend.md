# 内置模型后端部署

模型服务与训练代码现在随 Passive-BCI 一起提供，位于 `embedded/ncc/`。不需要克隆 NCC-OI-BCI，也不再扫描 Desktop、Documents、相邻 NCC 仓库或固定名称的 Conda 环境。`embedded/ncc` 和 Python 包名 `bci_dayloop` 保留来源命名，避免破坏权重格式与已有模块接口。

## 已内置的范围

- REVE 服务、预处理、已有 LoRA／分类头载入、在线分类头更新。
- Mock 服务，以及 runtime-package loader 和所需的本地模型实现。
- 分类头列表、gaze 头报告校验与选择。
- HDF5 数据读写、SMR 匯出、linear probing、gaze 训练。
- 现有逐组 probing 和轮末 LoRA 的训练入口与依赖模块。
- 独立 EEGNet 服务。
- Omni SDK 桥接引用的服务模块，以及 Neuracle TCP reader。

模型权重、厂商驱动和第三方 Python 包不属于源码，不会随 Git 克隆自动下载。保留 `NCC_PYTHON` 作为显式解释器路径的兼容别名；它不会触发外部仓库搜索。`NCC_EMBED` 已不再决定代码来源，旧 `--embed` 参数仍可使用，所有模型服务默认走内置代码。

## Python 环境

解释器优先级为 `PASSIVE_BCI_PYTHON`、显式 `NCC_PYTHON`、项目 `.venv`，最后才是 PATH 的 Python。建议 Python 3.11。核心依赖固定在 `requirements-backend.txt`，PyTorch 按平台单独安装。

Windows 原生 CUDA 安装命令（会下载依赖，按需要手动执行）：

```powershell
powershell -NoProfile -File scripts/setup-backend.ps1 -Device cuda
```

该脚本创建项目 `.venv`，安装 PyTorch 2.7.1 的 CUDA 12.8 构建，再安装核心依赖。CPU 机器使用 `-Device cpu`。此版本组合沿用原 Windows REVE 环境清单；安装脚本存在不代表已经通过新主机 GPU 验收。

macOS／Linux 可手动创建环境：

```sh
python3.11 -m venv .venv
.venv/bin/python -m pip install torch==2.7.1
.venv/bin/python -m pip install -r requirements-backend.txt
```

Linux CUDA 机器应使用与目标驱动匹配的官方 PyTorch CUDA wheel。设备 SDK 按需安装：Omni LSL 使用 `bridges/omni/requirements.txt`；Omni BLE 需要提供 `omnibci` SDK；BCIGo 使用其独立依赖清单，若版本与核心环境冲突，通过 `BCIGO_PYTHON` 指定单独环境。硬件 SDK 不用以模拟包替代。

## 权重与分类头

默认位置：

```text
Passive-BCI/
  .venv/
  embedded/ncc/                 服务与训练源码
  checkpoints/
    backbones/
      reve-base/               完整模型目录
      reve-positions/          完整位置模型目录
    adapters/
      <encoder-id>/best.pt
  recordings/.reve-heads/       被试分类头及报告
```

基座目录需包含模型本身要求的配置、自定义 Python 模型文件和权重，不能只复制一个 `model.safetensors`。位置库也要完整。权重可放在其他目录，通过 `REVE_CHECKPOINT_ROOT`、`REVE_ADAPTER_ROOT` 显式指定绝对路径。

旧分类头或报告内如果写有旧机器的绝对 LoRA 路径，需要据实迁移配置；系统不会静默换用另一个 encoder。分类头、adapter、类别顺序和预处理必须匹配。

SMR 默认初始化仍需要指定的初始 LoRA；测试纯基座管线时可显式使用 `--fresh-head --no-lora`，此时分类头未训练，不能把输出当作有效脑控判断。

## 启动与检查

```sh
npm run backend:doctor
npm run test:ncc-embed
npm run model-service:mock
npm run model-service:reve:smr
npm run model-service:eegnet
npm run dev -- --host 127.0.0.1
```

以上服务按需要选择，不应同时抢占同一端口。`backend:doctor` 仅检查环境和文件，不安装、不下载；加 `-- --require-weights` 可要求基座文件存在。它不是实际推理测试。

网页管理的 REVE／Mock 服务使用 **8768**，`/ws/model` 代理也指向 **8768**，不再把页面转发到另一个 8770 服务。双轴辅助服务仍可独立使用 8769，随机 EEGNet 默认使用 8773。`follow_reve_tcp.py` 的 8770 是可选跟随网页自身的 HTTP 端口，与模型代理无关。

```sh
npm run model-service:reve:smr:export -- --help
npm run model-service:reve:smr:fit -- --help
node scripts/run-gaze-fit.mjs --help
```

网页训练任务通过 `scripts/run-training.mjs` 调用本地 `training-job.py`，后者只从本仓库载入数据与训练模块。LoRA 核心仍在 `scripts/round_lora.py`。

需要保留旧 runtime package 时，设置 `MODEL_PACKAGE` 为该模型包路径后启动服务。loader 及支持的模型实现已内置，模型包资产仍需单独提供。

## 验证边界

2026 年 10 月 26 日在现有 macOS Python 环境完成：

- 核心服务、HDF5、SMR／gaze 训练帮助模块和 runtime-package loader 的隔离匯入。
- 多个 Python CLI 的独立入口检查。
- HDF5 真实读写往返和合成特征上的真实线性头优化。
- 从 Node 启动器启动内置 Mock，发送二进制 EEG 窗口并收到分类响应；测试将 NCC 仓库变量设置为不存在的路径。
- 原有训练任务的分组划分与发布测试；其中模型特征使用测试替身，不代表 REVE 实测。

没有安装新的 `.venv`、没有下载模型权重，也没有执行真实 REVE／LoRA／Windows RTX 5060 验收。`scripts/smoke-round-lora.py --output <新目录>` 保留真实 CUDA 训练／重载检查入口，需在相应环境和权重就绪后执行。

后端测试入口为 `npm run test:backend`。原有训练任务回归为 `python scripts/test_training_job.py`。特征可分的合成数据测试只验证代码链路，不报告被试分类性能。

## 来源与维护

补齐模块来自 Wang-Shinan/NCC-OI-BCI 的固定提交 `d5c30dcff18557045dbbabec8f18c797ef9663eb`，与现有内置服务来源一致。原有 10 月 19 日 Omni 修改保留。文件来源、上游 blob 标识与本地修改说明记录在 `embedded/ncc/SOURCE.json`。

后续直接维护内置代码。旧 `vendor-ncc-serving.mjs` 已停止执行覆盖式快照，以免覆盖本项目修复。升级上游时应按明确提交比较差异，保留来源和必要的第三方声明。

## 切换架构与完整权重

共用模型面板现可选择 REVE 或 EEGNet，并独立选择模型权重。选择配置后点击应用才生效；录制中的应用继续走保存旧段、切换、开启新段的流程。

- REVE：权重目录下的完整基座（`checkpoints/backbones/<目录>/model.safetensors`）和 adapter（`checkpoints/adapters/**/*.pt`）会出现在权重列表。未显式选权重时沿用所选分类头的配套 encoder。显式选择与分类头不一致的 encoder 会报错，不静默混用。
- EEGNet：选择“重新随机初始化”不读取历史文件。种子可配置，通道数采用当前 EEG 通道数，未连接时为 32。生成的完整 checkpoint 保存到 `recordings/.eegnet/`，以后可重新选择。
- 已有 EEGNet：将 `.pt`／`.pth` 放入 `checkpoints/eegnet/` 或 `recordings/.eegnet/`，点击“刷新权重”后选择。载入 encoder 与 classifier 的完整 `state_dict`；推理版本由文件内容确定。

EEGNet checkpoint 使用本仓库 `EEGNet` 结构，并包含 `architecture: "eegnet"`、`n_channels`、`n_samples`、`sample_rate`、`class_names` 和 `state_dict`。当前类别固定为 `left_hand, right_hand, tongue, rest`；预处理为每通道 z-score。历史 `smr-random.pt` 格式可读取。其他 EEGNet 变体／无元数据的裸 state dict 不能假定兼容，需要先转换为匹配格式。通道数不符时拒绝推理，不再静默补零或截断；通道语义及顺序仍需与训练一致。

网页托管的 EEGNet 与 REVE 使用同一管理端口 8768；独立 `model-service:eegnet` CLI 仍默认 8773。分组 SMR 连接器复用已选择的托管 EEGNet，不再强制连接另一个旧端口。

测试命令：`python scripts/test_eegnet_weights.py` 验证初始化／重载／不兼容输入；`python scripts/test_eegnet_service.py` 验证真实 WebSocket 随机权重保存后重新载入的版本和输出一致。这些是合成输入测试，不是训练有效性或被试准确率验证。
