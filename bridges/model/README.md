# NCC Runtime 模型服务接入

Passive BCI 负责采集与切窗；推理和在线适配留在独立的 [NCC-OI-BCI](https://github.com/ttkx-web/NCC-OI-BCI) Python 服务里。

## 边界

- 浏览器只发送 **原始 EEG 窗口**（`uV`，`layout=CT`，4 秒窗）
- 不要把浏览器 FFT / 频域特征当作 50M 输入
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

本地还没有 Runtime Package 时，可先用 **dev mock** 做链路验收（固定概率、Neuracle 59 导 @ 1000 Hz / 4 s）：

```bash
# Passive BCI 项目根目录
npm run model-service

# 或直接在 NCC-OI-BCI：
python scripts/serve_dev_mock_model.py --host 127.0.0.1 --port 8768
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

BCIGo 联调示例：

```bash
MODEL_DEVICE_PROFILE=bcigo32 npm run model-service
```

协议：JSON header + little-endian float32 CT 二进制；`window_id` 可为 number 或 string。