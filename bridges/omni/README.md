# OmniBCI V19 本机 API

OmniBCI V19 应用自己在本机开 WebSocket，浏览器**不需要**再起 Python 桥。采集页默认走这条路径；USB 串口直连固件仍可作为备选。

官方 Python SDK 与协议说明放在本目录（`omnibci_sdk.py`、`API_SDK_GUIDE.md`），网页客户端在 `src/acquisition/omni/`。

## 用法

1. 打开 OmniBCI V19 桌面应用，连接设备并**开始测量**。
2. 应用会在本机监听：
   - 数据：`ws://127.0.0.1:8765/v1/stream`
   - 控制：`ws://127.0.0.1:8765/v1/control`
3. `npm run dev` →「采集调试」→ 设备选 **OmniBCI**，链路选 **V19 应用 API** → **连接** → **开始采集**。

默认订阅 `raw`（μV，8 导，250 Hz）。显示滤波仍由采集页自己做，避免和应用内滤波叠两层。需要应用当前滤波输出时，把链路旁的流切到 `filtered`。

连接后如果 hello 成功但没有样本，说明应用还没开始测量：在 OmniBCI 里点开始后再等数据。消费端跟不上时，API 会发 `gap`（丢样本），本页会计入 loss，不会用假数据填洞。

## 和 USB 串口的区别

| | V19 应用 API | USB 串口 |
|---|---|---|
| 谁占用设备 | OmniBCI 应用 | 本页 Web Serial |
| 数据 | JSON 头 + float32 矩阵 | 48 字节 ADS1299 帧 |
| 通道增益 / 参考 / 阻抗 | 在 OmniBCI 应用里设置 | 本页下发固件命令 |
| 浏览器 | 任意本机 localhost | 需要 Chrome / Edge Web Serial |

同一时刻只能选一种：应用开着时不要再抢 USB。

## 触发 / 导出

SDK 还提供 `send_trigger`、`send_marker`、`stop_measurement`、`export_bdf`。网页采集目前只消费实时流；控制通道实现见 `src/acquisition/omni/client.ts` 的 `sendOmniTrigger`。
