# OmniBCI GUI HTTP 链路（只读）

采集页设备 = OmniBCI、链路 = **GUI HTTP 广播** 时，前端通过同源代理
`/api/omni-gui/*` → `http://127.0.0.1:8766/*` 订阅本机 OmniBCI GUI 的
web service（见 GUI 仓库 `docs/api-control.md`）。

## 使用

1. 本机运行 OmniBCI GUI（需 **api-control 构建**，见下）。
2. 在 GUI 中开始 EEG 采集（HTTP 服务只转发 GUI 自己的采集；本页不控制设备、不发触发）。
3. 采集页选 链路 = GUI HTTP 广播 → 连接 → 开始采集。
   - `GET /v1/status`：诊断（connected / streaming / api_control_enabled / frames / sequence_lost / frame_crc_bad / stale / snapshot_age_ms / session_id）。状态栏显示这些上游计数，与本地丢包统计基准不同，不混用。
   - `GET /v1/data`：原始设备帧的有序游标订阅（generation + cursor，页上限 5000，缓冲约 90 s）。本地从连接时的末尾游标开始，不回放历史；`409` 或游标/generation 变化会显式报错停止，不拼接。
   - 数据为 sample-major `values_uv`（float32 µV），每行带 sequence / valid / mode / 可选 source_timestamp_us（32 位设备时钟，环绕，未映射到墙钟）。

## 已准备好的 api-control 构建

本机已有构建产物（api-control 特性，HTTP 监听 127.0.0.1:8766）：

```
C:\Users\kiki2\Desktop\Shinan\omnibci-gui\target\passive-bci-http\release\omnibci-gui.exe
```

GUI 正常重启后默认回到 **USB 链路**（`connected=false`，`/v1/data` 暂为空）。
需要手动在 GUI 中操作一次：

1. 启动上述 exe；
2. 在 GUI 里把链路切到 **BLE**、选择设备并连接；
3. 在 GUI 中点**开始采集**；
4. 然后在本页选 链路 = GUI HTTP 广播 → 连接 → 开始采集。

在 GUI 完成第 3 步前，`/v1/status` 正常但 `/v1/data` 为空且
`channel_names=[]`——此时没有 EEG 数据可读，本页不会声称有数据。

## api-control 构建要求

`/v1/status` 在任何构建可用，但只有 api-control 构建提供 `/v1/data`
（否则 404）。若 `api_control_enabled=false`，页面会显示诊断并明确报错
「GUI当前构建未启用api-control」，不会假装有 EEG 数据、不会回退到
LSL / SDK 链路。

在 GUI 仓库中构建：

```sh
cargo build --release --locked --features api-control --bin omnibci-gui
```

随后正常启动 GUI 即可，HTTP 服务监听 `127.0.0.1:8766`。

## 限制

- 只读：本链路不发 `/v1/control`、不发触发、不启动/停止 GUI 采集。
- 当前随系统安装的 GUI 可能未启用 api-control（`/v1/status` 中
  `api_control_enabled=false`）——需上述构建后才可拿到数据；未做实测验证。
- source_timestamp_us 是环绕设备时钟，仅随内存数据批次透传，尚未写入 BIN 或时钟索引，不能据此离线还原源时间轴。
