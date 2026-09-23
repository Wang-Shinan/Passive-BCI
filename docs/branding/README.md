# Omni-Intelligence Logo

用户于 2026-09-23 提供原始位图，保存在 `omni-intelligence-original.png`。使用 imagegen 编辑配色后接入预览，保留全域智能 / Omni-Intelligence 名称与标志组合。

- `public/branding/omni-intelligence-light.png`：暖橙标志、深灰文字，透明背景。
- `public/branding/omni-intelligence-dark.png`：蓝色标志、浅色文字，蓝黑背景。使用实色背景版本避免透明提取造成的字形边缘杂点。
- `src/preview/BrandLogo.tsx`：共享标志组件，两张图片同时载入，CSS 根据 `html[data-preview-theme]` 切换可见性。目录侧栏和实验页顶栏使用相同组件；辅助技术读取单个品牌名称。

桌面、320px 和 390px 实验页顶栏通过浏览器检查；两种主题图片均成功载入，品牌链接返回目录，原有 19 个入口保留。预览构建与相关代码 lint 通过。
