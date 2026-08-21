# Neuracle（博睿康）WebSocket 桥接

浏览器无法直连 Collect 的 TCP 转发端口。本桥接复用官方 `DataServerThread`（oi-mi 或同级 NCC-OI-BCI vendor 副本），转到本机 WebSocket。

## 怎么开转发（Collect V2.11 手册）

依据 U 盘《NeuroHUB 多模态同步采集软件 V2.11》§3.2 / §3.2.3.1.5：

1. 登录界面点 **实时采集**
2. 点 **新实验**，填实验名称，选好被试与设备（采样率可选 250 / 500 / 1000 / 2000 / 4000 Hz）
3. 点 **开始实验**
4. 在实验采集界面菜单栏点 **开始**（第二组按钮，开始采集）
5. 再点第五组的 **数据转发**。弹出窗口后，选择要转发的被试探头，点 **开始**

这时 Collect 才会在本机打开 TCP 转发口。桥接会先看 JellyFish 进程实际监听的端口，再扫 `8700–8730`，不必手填 8712 / 8713。

不要和实验设置里的 **LSL 数据转发** 勾选搞混：那是另一条流，本桥接走的是 Collect TCP 数据转发。

## 采集页

Host / Port 留空即可自动探测。采样率选「自动」时，先按 1000 Hz 建连，再改用 META 里的 `sampleRates`。

`npm run dev` 打开「采集调试」→「博睿康 Neuracle」→ 连接（开发服务会自动拉桥）。

WebSocket：`ws://127.0.0.1:8766/v1/stream`

## 延迟

桥接默认立刻转发每一包（不再攒满 20 包）。采集页重连即可。

Collect 出厂还会按约 100 ms 一块推 TCP（`Conf\SystemSetting.json` 的 `TransferTimeLengthMin`）。若画面仍慢半拍：关掉 Collect，把该值改成 `20` 或 `50`，再开采集并重新点「数据转发」。滤波显示（5 Hz 高通）也会带来一点群延迟，对比时可先关掉。
