# OmniBCI LSL 桥接

## 双时钟记录（ERP 对齐审计）

所有实验事件的 `systemClock` 同时保存 `wallUnixMs`（Date.now 系统 UTC 毫秒）、`monotonicMs`（performance.now）、`timeOriginUnixMs`、`monotonicUnixMs`（固定 timeOrigin + 单调时钟）。前者可能随系统校时跳变，后者用于时长计算；`wallReadSpanMs` 仅表示读取系统钟前后两次单调钟之间的跨度，不是硬件同步误差上界。
Omni WebSocket 在消息回调入口、JSON/二进制解码前采集 `receivedClock`；录制侧另外保存 `systemClock`，区分接收与处理时刻。同一批样本共享接收时刻，不能将其当作每点采样时刻。
逐帧硬件/源时间保持为 `nativeFrames[].source_timestamp_ms`，缺失仍为 null，原始 sequence 保留；事件的 `eeg.native` 只引用最近收到的帧，不宣称是刺激对应采样点。LSL 源时间仍在 `lsl.timestampsSec`，不可未经映射与系统 UTC 直接相减。
行为 JSON、事件 JSONL 和 CSV 均保存事件系统时间；Trigger 回执另保留 OmniBCI 的 `host_time`、`sequence` 和 `sample_index`。这不保证光子级刺激时间精度；ERP 的实际显示偏差需要光电传感器/硬件触发实测校准。

## 原生 WebSocket 与 Trigger（优先用于直接接收）

支持 [OmniBCI-R Web API](https://github.com/Omni-Intel/omniBCI-R/blob/main/docs/web-api.md)。
在 OmniBCI「工具 > Trigger / 转发」启用 Web API / Trigger 和 WebSocket 实时转发，网页采集页选择「OmniBCI 应用转发 → 原生 WebSocket · 8766」。
EEG 从 `ws://127.0.0.1:8766/v1/stream` 接收，不发送 subscribe，不需要 Python/LSL 桥接；原生帧序号、可空的源时间戳和帧内 trigger 保存到 `context.jsonl` 的 `omni_native_frames` 记录，按字节偏移对应 EEG。
此接口的 `source_timestamp_ms` 可为空；原生直连不等同于获得 LSL 时间戳，不能将缺失的源时间戳伪造成采样时间。

N-back 设置中勾选「向 OmniBCI 写入 Trigger」；需要 OmniBCI 自身正在录制并已收到首帧（网页录制不替代这一步）。
通过 `POST /v1/trigger` 仅发送 `code`、`label`；本机 Vite 同源代理转发到 8766，解决 API 未启用 CORS 的问题。可与原生或 LSL 数据链路一起使用。
记录 `trigger_request`、`trigger_ack` / `trigger_error`，保存 host_time、sequence、sample_index 和往返时间，失败不自动重试以免重复打标。超时表示结果未确认，不能断言设备没写入。
事件码：100 开始；110+N 记忆刺激；120+N 非目标；130+N 目标；200 作答；300 完成；301 中止。label 带 block UUID、事件类型和试次号。
原生 API 默认端口 8766 与本项目 Neuracle 桥接端口相同，不要同时启动占用同一端口的服务。原生 API 不可用时可手动选择 LSL 桥接。

新版 OmniBCI 通过 Lab Streaming Layer（LSL）发布 EEG。浏览器不能直接订阅 LSL，因此本项目用 `lsl_ws_bridge.py` 把 LSL EEG 转成采集页已有的 WebSocket 协议。

## 用法

1. 在 OmniBCI 中连接设备、开始测量并启用 LSL。
2. 安装一次依赖：`pip install -r bridges/omni/requirements.txt`。
3. 运行 `npm run dev`，进入「采集调试」，设备选择 **OmniBCI**、链路选择 **LSL 桥接**，然后点「连接」。

网页会自动启动桥接进程。桥接优先选择名称或 source ID 包含 `omni` 的 `EEG` 类型 LSL 流；没有匹配时使用发现的第一个 EEG 流。

桥接监听 `ws://127.0.0.1:8771/v1/stream`，端口 8765 留给 OmniBCI 应用，8768/8769 留给模型服务。当前 OmniBCI 只发布一条 EEG LSL 流，所以网页中的流固定显示为 `LSL EEG`。通道标签缺失时使用 `CH1` 至 `CHn`；采样率和通道数从 LSL 元数据读取。

`omnibci_sdk.py` 和 `API_SDK_GUIDE.md` 是旧版 8765 WebSocket API 的兼容资料，不再用于当前采集链路。
# LSL 时间戳与事件对齐

桥接保留 `pull_chunk()` 返回的逐样本原始秒级时间戳，不启用时间戳后处理。
`lsl.correctionSec` 是 `inlet.time_correction()` 的结果：原始时间戳加该值得到桥接机 `local_clock()` 时间。
浏览器通过四时间戳 WebSocket 往返采样映射 `performance.now()`，每 2 秒刷新，使用最近 30 秒内最小 RTT 样本；过期时事件 LSL 时间为 null。

磁盘录制在 `context.jsonl` 持续写入 `type: "lsl_timestamps"`：包含 `lsl.timestampsSec`、校正值、源流 UID，以及 `eeg.bin` 中对应的 `byteOffset` / `byteLength`。不受实时样本时钟的 1024 批缓存限制。
事件 `eeg.lsl.eventLocalSec` 为事件的桥接机 LSL 时间，配合 `syncRttMs`、`syncAgeMs`、`browserOffsetMs` 判断同步质量；行为快照中字段位于 `data.eeg.lsl`。
比较事件与 EEG 时，使用 `eventLocalSec` 与 `timestampsSec[i] + correctionSec`，不要把旧的“最新收到样本编号”当作精确事件采样点。
内存下载回退会同时导出 `.lsl.jsonl`。旧录制没有保留下来的 LSL 时间戳无法补回；浏览器绘制事件也不是光电测得的真实屏幕亮起时间。

## 首包系统时间

每次网页录制的首个非空 EEG 数据包会固定生成 `firstDataReceived`：
- `systemClock.wallUnixMs`：系统 Unix 毫秒时间；同对象保留单调时钟和 time origin。
- `capturePoint=transport_receive`：使用 WebSocket 消息入口的接收时间；没有传输入口时间的设备记为 `recorder_append`，不冒充网络接收时间。
- `byteOffset=0`：对应本文件第一个数据包，不是点击开始录制的时间，也不是 ADC 硬件采样时间。

首包到达后即作为 `first_data_received` 记录进入 context 日志队列；正常结束时写入 `eeg.json` 和 `session.json`。内存回退下载另存 `.timing.json`。每次录制重置，空数据包不会触发首包计时，旧录制不补造该字段。
