# 清影下载器 (QingYingDownloader)

Windows 桌面视频/图片下载器（Electron 壳 + yt-dlp / gallery-dl 双引擎），v1.4.0。本仓库为应用源码（`C:\software\QingYingDownloader` 打包版的 asar 源），配套工具（yt-dlp / gallery-dl / ffmpeg）随打包版内置。

## 功能特性

- **视频下载**：yt-dlp 引擎，视频/音频格式分离选择，可选合并
- **图片下载**：yt-dlp 失败或空结果时自动降级 gallery-dl
- **多平台**：Bilibili / 抖音 / TikTok / Instagram / YouTube 等；TikTok 解析内置浏览器 UA（过反爬 JS challenge）
- **登录会话**：五平台 Cookie 登录态注入（Bilibili 风控严格时 API 链路仍可用）
- 图片落盘使用 Node 原生 https（绕开 Electron net.fetch 挂死问题）

## 版本锁定（勿随意升级）

| 工具 | 版本 | 原因 |
|---|---|---|
| yt-dlp | 2026.07.04 | 2026.08.19 版实测破坏 TikTok 解析且修不好 B站 412 |
| gallery-dl | 1.31.10 | 新版 release 不再附 exe |
| ffmpeg | 6.1.1 | 复用打包版自带 |

## 源码结构

```
electron/main.cjs      主进程：引擎调度、格式解析、下载队列、Cookie 注入
electron/preload.cjs   预加载桥
renderer/              界面（index.html / app.js / styles.css / 图标）
```

## 修改与打包方式

打包版无构建链，采用 asar 往返：

```powershell
npx asar extract C:\software\QingYingDownloader\resources\app.asar QingYingDownloader_src
# 修改源码后 node --check 校验
npx asar pack QingYingDownloader_src C:\software\QingYingDownloader\resources\app.asar
```
