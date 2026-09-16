# OmniBCI LSL 桥接

新版 OmniBCI 通过 Lab Streaming Layer（LSL）发布 EEG。浏览器不能直接订阅 LSL，因此本项目用 `lsl_ws_bridge.py` 把 LSL EEG 转成采集页已有的 WebSocket 协议。

## 用法

1. 在 OmniBCI 中连接设备、开始测量并启用 LSL。
2. 安装一次依赖：`pip install -r bridges/omni/requirements.txt`。
3. 运行 `npm run dev`，进入「采集调试」，设备选择 **OmniBCI**、链路选择 **LSL 桥接**，然后点「连接」。

网页会自动启动桥接进程。桥接优先选择名称或 source ID 包含 `omni` 的 `EEG` 类型 LSL 流；没有匹配时使用发现的第一个 EEG 流。

桥接监听 `ws://127.0.0.1:8771/v1/stream`，端口 8765 留给 OmniBCI 应用，8768/8769 留给模型服务。当前 OmniBCI 只发布一条 EEG LSL 流，所以网页中的流固定显示为 `LSL EEG`。通道标签缺失时使用 `CH1` 至 `CHn`；采样率和通道数从 LSL 元数据读取。

`omnibci_sdk.py` 和 `API_SDK_GUIDE.md` 是旧版 8765 WebSocket API 的兼容资料，不再用于当前采集链路。
