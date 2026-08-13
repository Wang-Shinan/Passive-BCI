# Neuracle（博睿康）WebSocket 桥接

浏览器无法直连 JellyFish 的 TCP `8712`，本桥接复用 [oi-mi](../../oi-mi) 的 `collect/neuracle_api.py`，把 EEG 转到本机 WebSocket。

## 用法

1. 打开博睿康 JellyFish，开启数据转发（默认 `127.0.0.1:8712`）
2. 在 Passive BCI 项目根目录：

```bash
npm run neuracle-bridge
# 或指定 oi-mi 路径
OI_MI_ROOT=/path/to/oi-mi npm run neuracle-bridge
```

3. `npm run dev`，打开「采集调试」→「博睿康 Neuracle」→ 连接并开始采集（开发服务会自动拉起桥接；也可手动 `npm run neuracle-bridge`）

WebSocket：`ws://127.0.0.1:8766/v1/stream`（Vite 开发时也可走 `/ws/neuracle` 代理）

默认订阅 oi-mi 的 59 导头皮 EEG（排除 ECG/EOG）。
