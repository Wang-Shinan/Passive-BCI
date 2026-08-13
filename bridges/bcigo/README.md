# 强脑 BCIGo（BrainCo）WebSocket 桥接

浏览器无法直连设备 Wi‑Fi TCP，本桥接使用官方 [bcigo-sdk](https://pypi.org/project/bcigo-sdk/)，经 mDNS 发现或手动 `host:port` 拉 EEG，再转到本机 WebSocket（与 Neuracle 桥同一套 JSON+float32 协议）。

默认 **32 导 10–20**：FP1…TP10 + IO（参考）。

## 用法

1. 耳机/帽上电，手机或电脑连上同一 Wi‑Fi（强脑无线热点或局域网）。
2. **建议先退出强脑官方 App**，避免独占 TCP（本机实测：能 mDNS 发现并 `start_stream`，但 App 占用时可能一直收不到样本）。
3. 安装依赖并启动桥接：

```bash
pip install -r bridges/bcigo/requirements.txt
npm run bcigo-bridge
# 或
python3 bridges/bcigo/ws_bridge.py
```

4. `npm run dev` →「采集调试」→「强脑 BCIGo」→ **连接并开始采集**（开发服务会自动拉起桥接；也可手动 `npm run bcigo-bridge`）。

WebSocket：`ws://127.0.0.1:8767/v1/stream`（开发时也可走 Vite 代理 `/ws/bcigo`）

## 订阅字段

| 字段 | 说明 |
|------|------|
| `host` / `port` | 可选；省略则 `mdns_start_scan()` |
| `sample_rate` | 250 / 500 / 1000 / 2000，默认 250 |
| `gain` | 1–24，默认 6 |
| `signal` | `normal` / `test` / `shorted` / `mvdd` |
| `msg_type` | 默认 `BCIGo`（其它型号见 SDK `MsgType`） |

## 数据格式

`get_eeg_buffer` 每行实测为 **33 列**：`[sample_index, 32×EEG]`。桥接会丢掉序号列，按文档 32 导名转发。部分未佩戴/脱落导联可能恒为 `-750000`（设备哨兵值）。

## 排障

- **能发现设备但无波形**：关闭官方 App / 其它 ECAP 客户端后重连；或在 UI 填已知 IP（例如 mDNS 扫到的 `ameba.local` / `192.168.x.x`）与端口。
- **mDNS 失败**：同一网段、关闭 VPN，或手动填 host/port。
- SDK 版本以本机 `pip show bcigo-sdk` 为准；API 以 PyPI 文档为准。
