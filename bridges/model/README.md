# NCC Runtime 模型服务接入

Passive BCI 负责采集与切窗；推理和在线适配留在独立的 [NCC-OI-BCI](https://github.com/ttkx-web/NCC-OI-BCI) Python 服务里。

## 边界

- 浏览器只发送 **原始 EEG 窗口**（`uV`，`layout=CT`）
- 窗长由服务端 hello 的 `input.window_sec` 决定：50M / mock 为 4 秒，本地 REVE 为 **2 秒**。在线步长：俄罗斯方块页的 `smr_control` 与 `tetris_action` 为 **0.1 秒**（10 Hz）；`/smr-adapt` 仍为 0.5 秒。离线 export/fit 切窗不重叠（hop=窗长），不要用在线 0.1s hop。
- 不要把浏览器 FFT / 频域特征当作模型输入
- 当前 MI 四分类头仅用于链路验收；只有服务明确返回 `output_semantics: "ordinal_rating_3"` 时，RL 实验才允许用预测当作三类奖励

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

适配页 `/smr-adapt` 会一键拉起该头（**strategy=none，不在线微调**）。已经录过的 `recordings/*smr-adapt*` bin **可以直接离线训头**，不必重采：

```bash
npm run model-service:reve:smr:fit
```

`smr_control` 默认合并 S02 0821 LoRA（`checkpoints/adapters/smr_control_s02_4class_reve_0821_livehead_lora/best.pt`），配对本地 811 线性头 `recordings/.reve-heads/smr_control_s02_4class_livehead.pt`（`encoder_id` 必须等于该 LoRA 目录名）。无 0821 时回退上一版 S02 livehead LoRA。退回 Stieger 四分类 mi5init：`$env:MODEL_REVE_LORA=".../stieger2021_4class_reve_lora_r16_mi5init/best.pt"`。旧的左右手二分类适配器和 `smr_control_stieger_lora.pt` 不会自动加载。不要把左右/休息标签写进 `passive_rating`（任务一/任务二/任务三）。不要 LoRA 时加 `--no-lora` 或 `$env:MODEL_REVE_NO_LORA="1"`。退回二分类：`$env:MODEL_REVE_LORA=".../stieger2021_lr_reve_lora_r16_mi5init/best.pt"`。

也可在终端手动启动三类头：

```bash
npm run model-service:reve
```

有正式包体时设置 `MODEL_PACKAGE=/path/to/runtime-package` 再运行 `npm run model-service`。

WebSocket：`ws://127.0.0.1:8768/v1/model`  
Vite 开发时也可走同源代理 `/ws/model`。

## 局域网跟随（TCP JSONL）

实验机启动 REVE 后会额外监听 **TCP 8769**（`0.0.0.0`），按行推送 `hello` / `prediction` / `feedback_ack`。**不传原始 EEG**。模型面板会显示本机局域网地址。

对端电脑（同一 Wi‑Fi / 局域网）**不必克隆仓库**。把这一份文件拷过去即可：

`scripts/follow_reve_tcp.py`

```bash
python follow_reve_tcp.py --host 192.168.x.x
```

终端会打印预测；浏览器打开脚本提示的 `http://127.0.0.1:8770` 可看条形图。只要系统自带 Python 3.8+。Windows 实验机需放行入站 8769。关掉 TCP：`$env:MODEL_NO_TCP="1"`。

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