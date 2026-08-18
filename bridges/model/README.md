# NCC Runtime 模型服务接入

Passive BCI 负责采集与切窗；推理和在线适配留在独立的 [NCC-OI-BCI](https://github.com/ttkx-web/NCC-OI-BCI) Python 服务里。

## 边界

- 浏览器只发送 **原始 EEG 窗口**（`uV`，`layout=CT`）
- 窗长由服务端 hello 的 `input.window_sec` 决定：50M / mock 为 4 秒，本地 REVE 为 **2 秒**
- 不要把浏览器 FFT / 频域特征当作模型输入
- 当前 MI 四分类头仅用于链路验收；只有服务明确返回 `output_semantics: "ordinal_rating_3"` 时，RL 实验才允许用预测当作「差/中/好」奖励

## 启动模型服务

在 NCC-OI-BCI 仓库：

```bash
python scripts/serve_runtime_model.py \
  --package /path/to/runtime-package \
  --host 127.0.0.1 \
  --port 8768 \
  --strategy none
# 监督式在线头（冻结 Backbone）：
# --strategy supervised-head --state-file /tmp/online-head.pt
```

本地还没有 Runtime Package 时，可先用 **dev mock** 做链路验收（固定概率；接受 Neuracle 59 导或 BCIGo 32 导，默认 4 s 窗）：

```bash
# Passive BCI 项目根目录（Windows / macOS / Linux）
npm run model-service
# 或 npm run model-service:mock

# 或直接在 NCC-OI-BCI：
python scripts/serve_dev_mock_model.py --host 127.0.0.1 --port 8768
```

启动器会依次查找 `NCC_OI_BCI_ROOT`、与 Passive BCI 同级的 `NCC-OI-BCI`、以及 `bci-dayloop` conda 环境。

本地 REVE（2 秒窗，服务端重采样到 200 Hz）。**Windows PowerShell 请用 npm script**，不要写 `MODEL_BACKEND=reve npm …`（那种 Unix 前缀不会生效，会落到默认 mock）：

```bash
npm run model-service:reve
# large：
npm run model-service -- --backend reve
# 等价环境变量（PowerShell）：
# $env:MODEL_BACKEND="reve"; $env:MODEL_REVE_SIZE="large"; npm run model-service
```

浏览器打开首页的「基模在线学习」，选任务头再点启动（`npm run dev` 时由 Vite 一键拉起，无需另开终端）。已在跑的服务会直接连上。采集开流后按 1…N 给当前窗打当前 `class_names`；服务端只更新冻结 REVE 上的线性头。

俄罗斯方块操作分类（7 类：`rest/left/right/rotateCW/rotateCCW/softDrop/hardDrop`）：

```bash
npm run model-service:reve:tetris
```

或在方块页勾选「键盘操作在线学习」，开发服务会拉起 `tetris_action` 头。用键盘玩时把当前 2 秒窗标成该操作；可选「用预测操控方块」。

SMR 光标四类头（`left_hand` / `right_hand` / `both_hand` / `rest`）：

```bash
npm run model-service:reve:smr
```

适配页 `/smr-adapt` 会一键拉起该头，并按线索给当前 2 秒窗打标签。已经录过的 `recordings/*smr-adapt*` bin **可以直接训头**，不必重采：

```bash
npm run model-service:reve:smr:fit
```

拟合结果写到 `recordings/.reve-heads/smr_control.pt`，之后启动 `smr_control` 会自动加载。不要把左右/休息标签写进 `passive_rating`（差/中/好）。

也可在终端手动启动评分头：

```bash
npm run model-service:reve
```

有正式包体时设置 `MODEL_PACKAGE=/path/to/runtime-package` 再运行 `npm run model-service`。

WebSocket：`ws://127.0.0.1:8768/v1/model`  
Vite 开发时也可走同源代理 `/ws/model`。

## Passive BCI 侧

1. `npm run neuracle-bridge` 或 `npm run bcigo-bridge`（开发服务也会自动拉桥）并开始采集
2. 采集页打开「模型服务」面板，启用连接
3. RL Graph 实验可选奖励源 `foundation`：人工评分会按 `observation_id` 回传反馈

当前 dev mock / 旁路已支持两种固定布局：

| 设备 | profile | 通道 | 默认采样率 |
|------|---------|------|------------|
| Neuracle | `neuracle59` | 59 | 1000 Hz |
| BCIGo | `bcigo32` | 32 | 250 Hz |

协议：JSON header + little-endian float32 CT 二进制；`window_id` 可为 number 或 string。