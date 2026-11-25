# OmniBCI GUI HTTP 链路

采集页设备 = OmniBCI、链路 = **GUI HTTP 广播** 时，前端通过同源代理订阅本机 OmniBCI GUI 的
web service（见 GUI 仓库 `docs/api-control.md`）。设备仍归 GUI 所有：
本链路不调用 `/v1/control`，不启动/停止 GUI 采集，不直接操作硬件。

## 使用

1. 本机运行 OmniBCI GUI（需 **api-control 构建**，见下）。
2. 在 GUI 中开始 EEG 采集（HTTP 服务只转发 GUI 自己的采集；本页不控制设备）。
   连接时检查上游 `connected=true`、`streaming=true`、非空 `session_id`、
   状态未过期与有效数据尾页；实验开始及中断后恢复另需新鲜连续样本。
   收数依赖 `/v1/data`；非预览专注/咬牙还需 `/v1/trigger`。触发接口缺失或
   `collect` 起始标记未获有效 ACK 会使相关试次无效，不会自动改用本地时间充当成功的 GUI 锚点。
3. 采集页选择「GUI HTTP 广播」。留空「GUI HTTP 端口」会自动查询本机 8766 和 8769，优先选正在采集的 GUI。也可以输入转发端口，浏览器会记住输入。点击「连接」后再点「开始采集」。
   - `GET /v1/status`：诊断（connected / streaming / api_control_enabled / frames / sequence_lost / frame_crc_bad / stale / snapshot_age_ms / session_id）。状态栏显示这些上游计数，与本地丢包统计基准不同，不混用。
   - `GET /v1/data`：原始设备帧的有序游标订阅（generation + cursor，页上限 5000，缓冲约 90 s）。本地从连接时的末尾游标开始，不回放历史；`409`、游标/generation 变化、序号跳变/回退、无效帧或断流停滞时自动隔离旧数据并复位连续性：被中断的录制片段按「中断」落盘保存（含中断原因），随后只接受上游新的连续数据流并另开**关联的新片段**，绝不跨间隙拼接同一段数据。协议/页面结构变化、通道布局变化或 api-control 被停用时显式报错停止。
   - `POST /v1/trigger`：实验标记（见下节）。
   - 数据为 sample-major `values_uv`（float32 µV），每行带 sequence / valid / mode / 可选 source_timestamp_us（32 位设备时钟，环绕，未映射到墙钟）。

## POST /v1/trigger 实验标记

在「采集调试 → OmniBCI → GUI HTTP 广播 → CH340 硬件打标」选择配套打标板，并以只读方式授权 GUI 保存 BDF+ 的录制目录。此后专注、咬牙、SMR 和 N-back 录制在 STM32 32 导模式优先用已授权的 CH340，按 `10000/8N1` 发送 `A5、事件码、事件码 XOR FF`。

网页读取当前 GUI 会话新增的 `<会话号>_events.jsonl` 设备事件，核对后记录真实样点序号。授权或硬件在发送前不可用时，沿用 GUI HTTP 打标。串口发送一旦尝试，确认超时计为不确定，避免重复标记。会话事件的 `transport` 字段记录 `hardware_serial` 或 `gui_http`。

专注、咬牙及 SMR 采集在 GUI HTTP 链路的正式录制中发送标记。SMR 分组采集和普通 SMR 共用事件码。会话开始为 10，组开始、完成和中断分别为 150、151、152。各类提示用 160–163，采集起点用 170–173，试次结束用 180–183，各范围内依次为左手、右手、舌头和休息。无效试次用 190。

N-back 在 GUI HTTP 链路的正式录制中为字母出现和有效作答打标。目标刺激用 245，非目标刺激用 246，空格或「相同」按钮作答用 247，开头不计分的记忆试次刺激用 248。

- FIFO 异步队列，单在途请求；每条标记 2 秒超时，队列长度上限 32 条，
  排队超过约 2 秒即按过期取消，永不重试。
- ACK 严格校验：必须回显上游 `sequence`、`sample_index`、`session_id`
  与非空可解析 `host_time`；code 必须一致，若 ACK 带有 label，
  也必须与请求一致。上下文已切换的
  迟到响应记为 uncertain，不按成功对齐。这里的 `sequence`/`sample_index`
  是**设备帧锚点**，用于把标记定位到 EEG 样本流上，不是显示器刷新、
  光信号或任何硬件时间戳。
- 已取得 GUI 录制上下文的标记，其 request / ack / error 及
  uncertain / cancelled 结果写入该录制的事件审计（关联本地
  recording id / 分段号 + 上游 session id / generation），未发出的请求不写
  request。专注和咬牙的 `collect` 起始标记缺少 ACK 时，相应试次记为无效。
  SMR 和 N-back 的打标结果按原始事件 ID 写入事件日志，打标异步执行。

## 采集中断与恢复（专注 / 咬牙）

- 中断发生在准备/提示/采集阶段时当前试次**作废一次**（写入 invalid
  标记）；休息期中断不再重复作废或重复计数已完成的试次。中断片段按
  interrupted 保存，GUI 标记上下文随即停用。
- 恢复就绪 = 新片段已建立磁盘录制 + 上游确有新鲜连续样本；就绪后自动进入
  **下一个**试次的准备阶段，绝不重跑或续跑被中断的试次。
- 停止 / Esc 结束当前实验，并只抑制**本实验自己拥有**的录制重开；
  咬牙在 GUI 链路下直接复用采集页已有的录制（attach 但不拥有），
  实验正常结束不会关闭别人的录制，采集方仍可继续/重开自己的片段。
  咬牙的非 GUI 链路规则不变（已有录制仍拒绝开始）。
- 手动断开 GUI 连接会把当前片段按中断保存并停止客户端恢复，
  不会静默丢弃数据。

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
与 `/v1/trigger`（否则 404）。若 `api_control_enabled=false`，页面会显示
诊断并明确报错「GUI当前构建未启用api-control」，不会假装有 EEG 数据、
不会回退到 LSL / SDK 链路。

在 GUI 仓库中构建：

```sh
cargo build --release --locked --features api-control --bin omnibci-gui
```

随后正常启动 GUI 即可，HTTP 服务监听 `127.0.0.1:8766`。

## 限制

- 不控制设备：不发 `/v1/control`，不启动/停止 GUI 采集。
- 当前随系统安装的 GUI 可能未启用 api-control（`/v1/status` 中
  `api_control_enabled=false`）——需上述构建后才可拿到数据；未做实测验证。
- 上述中断恢复、标记队列与多试次行为目前仅由 mock 测试覆盖，真实
  OmniBCI 硬件与实际 GUI 版本尚未实测验证。
- 每帧的 `sequence` / `source_timestamp_us` 仅随内存数据批次透传，
  尚未完整写入 BIN 或时钟索引，不能据此离线逐样本还原源时间轴。
