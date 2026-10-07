# Fusion Pixel 字体

本目录使用 TakWolf 官方发布的 **Fusion Pixel 12px Monospaced zh-Hans** 原版字体。

- 官方项目：https://github.com/TakWolf/fusion-pixel-font
- 版本：2026.09.25
- 原始压缩包：https://github.com/TakWolf/fusion-pixel-font/releases/download/2026.09.25/fusion-pixel-font-12px-monospaced-otf.woff2-v2026.09.25.zip
- 原始压缩包 SHA-256：`d55feb57eed56183d0e0b09ab04deea0cbbfece0282ba0e840e07c7feac5f812`，已对照官方 release digest 校验。
- 文件：`fusion-pixel-12px-monospaced-zh_hans.woff2`，仅将原发布文件去掉名称中的 `.otf`，未修改字体内容。
- 许可：SIL Open Font License 1.1，完整许可及作者声明见 `OFL.txt`；上游许可保存在 `LICENSES/`。

字体通过本地 `@font-face` 加载，运行时不依赖 CDN。设计系统以原生 `12px` 渲染，全应用只使用 `--pixel-font-size` 一个字号 token。浏览器缩放保留正常可访问性，不强制缩小用户设置。
