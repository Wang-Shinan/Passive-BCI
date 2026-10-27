# OmniBCI 接入

## 在采集调试页使用 SDK BLE

1. 刷新「采集调试」页面，设备选择 **OmniBCI**，链路选择 **SDK BLE 直连**。
2. 在 **设备型号** 中选择 **ESP32 · 8 通道** 或 **STM32 / E73 · 32 通道**，点击 **搜索 BLE 设备**，选择设备后点击 **连接**。搜索使用对应硬件的 BLE 服务，页面自动启动本机 SDK 采集进程。
3. 点击 **开始采集** 查看所选设备的全部通道并录制原始 μV 数据；**停止**结束本次录制，**断开**解除页面订阅。连接或采集期间不能切换型号。
4. 展开 **通道名称与电极位置（REVE）**，按硬件 CH1→CH8 或 CH1→CH32 顺序填写位置。8/32 通道的配置和上次设备分别保存；显示名称可保留 CH 编号。位置可稍后填写，不影响波形与录制。
5. 需要模型时，先连接 SDK 并填写电极位置，再在模型面板应用 REVE 分类头，之后开始录制。模型与采集页共享同一个 SDK 设备连接；模型从本机 SDK 进程接收原始批次，自行切窗，不经过浏览器回传。

页面与模型都断开后才停止设备采样。若模型仍在运行，仅断开采集页不会释放板子；可在模型面板停止服务后更换设备或交回 OmniBCI 应用。录制期间不能更换模型或通道配置。SDK BLE 尚不支持页面阻抗测量。

本机 SDK 进程监听 `127.0.0.1:8772`，浏览器通过 `/ws/omni-sdk` 访问。页面模型启动自动使用 `--omni-relay` 共享连接。独立终端接入共享进程时，也需传 `--omni-relay`；下面不带该参数的命令是独占设备的独立运行方式。

### 通道名称与位置

OmniBCI 各链路均可保存独立的通道显示名称和位置。SDK BLE 与 LSL 模型输入会携带位置，保持硬件列顺序不变。未配置独立位置时兼容旧方式：使用通道名称查找位置。设置保存在当前浏览器；录制元数据保存 `channelNames`、`electrodeNames` 或 `electrodePositions`，以及坐标输入方式。采集期间禁止修改，修改后需重新应用模型。

- **标准电极位置**：按实际接线填写 C3、C4 等名称，由官方 REVE 位置库转换为三维坐标，所选设备的 8/32 路必须全部匹配且互不重复。
- **XYZ**：直接输入每路的 X、Y、Z，单位米，须对齐 REVE 位置库的原点、方向和尺度。X 向右、Y 向前、Z 向上，不自动居中或归一化。
- **球坐标**：每路填写方位角（度）、仰角（度）、半径（米）。方位角由 +X 朝 +Y 为正，仰角从 XY 平面朝 +Z 为正。转换公式为 `x=r*cos(e)*cos(a), y=r*cos(e)*sin(a), z=r*sin(e)`。二维头皮图上的角度与平面半径不能直接作为球坐标；不同软件的角度约定需先转换。

REVE 接收 `[batch, channels, time]` 的 200 Hz EEG 和 `[batch, channels, 3]` 的位置；本地服务将 Omni 250 Hz 数据重采样到 200 Hz，使用 2 秒窗口。位置名和坐标是两种输入方式，坐标方式优先；切换坐标输入方式会清空坐标，防止把角度误当米。参考：[官方位置库说明](https://huggingface.co/brain-bzh/reve-positions)。

## Python SDK 版本与安装

2026-10-19 本机已升级至官方 `32ch` 分支的 **omnibci 0.2.0 开发构建**，同时支持 ESP32 和 STM32。对应 Python 提交 `65945c6591a10218b6184e1dea0334e627e9bb7d`、内置 Rust SDK `40ac92a3f78cf2232df944f87c90fe89c160e50d`，来源为 [官方 CI run 39188901810](https://github.com/Omni-Intel/omnibci-python/actions/runs/39188901810)。这是 CI 开发包，尚非正式 0.2.0 Release。

Windows x64 / Python 3.11+，从 Passive-BCI 目录安装或校验：

```powershell
& ..\NCC-OI-BCI\.venv\Scripts\python.exe ..\NCC-OI-BCI\scripts\install_omni_sdk.py --check-only
& ..\NCC-OI-BCI\.venv\Scripts\python.exe ..\NCC-OI-BCI\scripts\install_omni_sdk.py --download
```

安装器优先使用工作区 `.tools/omni-0.2.0/` 缓存；缺失时通过 nightly.link 获取官方 CI 产物，并校验 GitHub 公布的压缩包 SHA-256 和解压后 wheel 的 SHA-256。CI 产物会过期，请保留缓存，也可通过 `--wheel <本地文件>` 指定同一构建。现有模型环境须已安装 NumPy ≥1.26。wheel SHA-256 为 `8d303762bca91efd5a864a8fd70daf1ecdf594e590425549d599c441b1a3b958`。

本地 Rust 仓库已更新到 `19eda53`，但上述 Python wheel 仍固定在 `40ac92a`，**不包含后续 ACK 接收解耦等修复**。更新 Rust 检出目录不会替换 wheel 内的原生库，后续需重新构建并验证绑定才能用上这些修复。当前不能声称已获得最新 SDK 的延迟收益。

8 通道仍兼容旧 0.1.2；`requirements-omni-windows.txt` 仅用于回退 ESP32，不能在需要 32 通道的环境中重新安装它。升级后应结束当前采集、停止使用同一设备的模型并重启 SDK 桥接，让新进程加载新版本。

## ESP32 BLE → Python 模型直连

模型可通过官方 `omnibci` Python 绑定直接控制 ESP32 8 通道板子。数据路径为 **BLE → SDK → Python 连续切窗 → REVE → WebSocket 预测**，浏览器不再接收并回传模型输入窗口。原有 LSL 采集入口仍可单独使用。

以下 ESP32 示例默认使用 8 通道；Python 环境安装方式见上节。PowerShell 命令从 **Passive-BCI 项目目录**执行：

```powershell
& ..\NCC-OI-BCI\.venv\Scripts\python.exe ..\NCC-OI-BCI\scripts\omni_devices.py
```

发现结果中的 `endpoint` 才是连接参数；Windows 的值可能形如 `ble://PeripheralId(...)`，不要直接使用 MAC 地址。仅检查采集链路、不录制 EEG、不运行模型：

```powershell
& ..\NCC-OI-BCI\.venv\Scripts\python.exe ..\NCC-OI-BCI\scripts\omni_devices.py --probe-endpoint 'ble://<发现结果中的 key>'
```

电极位置可稍后填写、随接线更改；没有默认布局。运行模型前必须提供按硬件 **CH1→CH8** 顺序排列的 8 个真实位置。`CH1` 等编号不是 REVE 位置：可用 `--omni-electrodes` 单独传 8 个逗号分隔的位置名，或用 `--omni-positions` 传 8×3 的 JSON 米制 XYZ 数组，此时 `--omni-channels` 可保留 CH1…CH8。没有独立位置参数时，沿用 `--omni-channels` 查找位置。更改后重启模型服务。

```powershell
$env:MODEL_OMNI_ENDPOINT = 'ble://<发现结果中的 key>'
$env:MODEL_OMNI_CHANNELS = '<CH1电极>,<CH2电极>,<CH3电极>,<CH4电极>,<CH5电极>,<CH6电极>,<CH7电极>,<CH8电极>'
npm run dev
# 浏览器模型面板启动 REVE，继承上述环境变量。
# 或独立终端启动（浏览器仅启用连接，不再重复启动服务）：
npm run model-service:reve -- --step-sec 0.1
```

也可用 `--omni-endpoint`、`--omni-channels` 替代环境变量。任务、LoRA 和分类头继续沿用原启动参数。当前配置要求设备已确认 EEG 模式、全部 8 通道启用；SDK 接入不会替用户改增益、参考或电极位置。GUI 和 SDK 不能同时占用同一板子，直连模式下请先释放 GUI 的连接，也不要启动 LSL 采集。

独立命令行模式只推送预测；上面的采集页共享模式同时支持波形和原始 EEG 录制。模型适配与分类头的有效性仍需针对实际 8 通道布局验证。

调度与测量：

- 使用 `read(timeout=0.1)` 获取当前批次，不用 `read(250)` 等待 1 秒样本。
- 保留 REVE 的 2 秒输入窗；`--step-sec 0.1` 表示每 100 ms 尝试更新，不能保证模型一定跑满 10 Hz。
- 采集与推理独立运行，最多保留一个待推理窗口，积压时取最新窗；默认丢弃 SDK 交付后超过 1 秒的窗口/结果。
- 样本索引断点、无效值或 generation 改变会重置连续段，重新积累完整窗口；不补零、不跨缺口拼接。超过 5 秒无数据或设备故障会退出并释放设备。
- 面板 `SDK交付→推理 P50/P95` 使用主机单调时钟，包含 SDK 交付后排队及计算，**不包含硬件采样/BLE 传输和浏览器接收延迟**。它不是端到端延迟，也不能直接与旧面板的纯计算耗时比较。

2026-10-11 本机验证：官方 Windows wheel 安装成功；BLE 探测及约 3 秒采集得到 762 个样本，0 无效样本、0 索引断点，并正常停止/关闭。模型接入另有模拟测试；实际电极布局未确认，尚未测量真实 REVE 脑控效果或新旧链路的延迟差。

## STM32 / E73 32 通道

页面选择 STM32 后会自动传递设备类型，模型复用同一个 SDK 连接，完整保留 32 路 EEG 与电极位置。命令行需要显式选择：

```powershell
& ..\NCC-OI-BCI\.venv\Scripts\python.exe ..\NCC-OI-BCI\scripts\omni_devices.py --device-type stm32
$env:MODEL_OMNI_DEVICE_TYPE = 'stm32'
$env:MODEL_OMNI_ENDPOINT = 'ble://<STM32 发现结果中的 key>'
$env:MODEL_OMNI_CHANNELS = '<32个按硬件顺序排列的真实电极位置，逗号分隔>'
npm run model-service:reve -- --step-sec 0.1
```

也可传 `--omni-device-type stm32`；独立 Python 服务支持 STM32 `serial://COMx`，页面目前提供 SDK BLE。切回 ESP32 时改为 `esp32` 并使用 8 路配置。模型要求已确认的 EEG 模式、全部通道启用且关闭 LOFF 激励。不要把其他设备的训练布局直接当作这块板子的布局；S04 31 电极双轴模型仍拒绝 Omni 输入。

STM32 绑定要求支持 AE/BE 完整配置事务的 32.0.5 系列固件，以及兼容的 E73 SPI 桥接/BLE 固件；具体约束见 [官方 STM32 文档](https://github.com/Omni-Intel/omnibci-python/blob/65945c6591a10218b6184e1dea0334e627e9bb7d/docs/stm32.rst)。

2026-10-19 验证覆盖官方 wheel 的软件测试、8/32 路共享连接、切窗与缺口重置，以及浏览器模拟搜索/连接/录制/模型参数和配置持久化；未进行本次 32 通道实机采集或端到端延迟对比。

## LSL 桥接

新版 OmniBCI 通过 Lab Streaming Layer（LSL）发布 EEG。浏览器不能直接订阅 LSL，因此本项目用 `lsl_ws_bridge.py` 把 LSL EEG 转成采集页已有的 WebSocket 协议。

### 用法

1. 在 OmniBCI 中连接设备、开始测量并启用 LSL。
2. 安装一次依赖：`pip install -r bridges/omni/requirements.txt`。
3. 运行 `npm run dev`，进入「采集调试」，设备选择 **OmniBCI**、链路选择 **LSL 桥接**，然后点「连接」。

网页会自动启动桥接进程。桥接优先选择名称或 source ID 包含 `omni` 的 `EEG` 类型 LSL 流；没有匹配时使用发现的第一个 EEG 流。

桥接监听 `ws://127.0.0.1:8771/v1/stream`，端口 8765 留给 OmniBCI 应用，8768/8769 留给模型服务。当前 OmniBCI 只发布一条 EEG LSL 流，所以网页中的流固定显示为 `LSL EEG`。通道标签缺失时使用 `CH1` 至 `CHn`；采样率和通道数从 LSL 元数据读取。

`omnibci_sdk.py` 和 `API_SDK_GUIDE.md` 是旧版 8765 WebSocket API 的兼容资料，不再用于当前采集链路。
