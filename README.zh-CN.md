# 清影下载器 (QingYingDownloader)

[English](README.md)

Windows 桌面视频/图片下载器（Electron 壳 + yt-dlp / gallery-dl 双引擎），v1.4.0。本仓库为应用源码（`C:\software\QingYingDownloader` 打包版的 asar 源），配套工具（yt-dlp / gallery-dl / ffmpeg）随打包版内置。

## 功能特性

- **视频下载**：yt-dlp 引擎，视频/音频格式分离选择，可选合并
- **图片下载**：yt-dlp 失败或空结果时自动降级 gallery-dl
- **多平台**：Bilibili / 抖音 / TikTok / Instagram / 小红书登录会话；YouTube 等公开内容经 yt-dlp 免登录直接下载
- **登录会话**：五平台 Cookie 登录态注入（Bilibili 风控严格时 API 链路仍可用）
- **TikTok 反爬**：内置浏览器 UA（过反爬 JS challenge）
- 图片落盘使用 Node 原生 https（绕开 Electron net.fetch 挂死问题）
- 下载队列与进度展示

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

## 运行（源码方式，Windows）

> 本仓库为打包版的 asar 提取源码；若只想下载文件，直接使用打包版即可（工具已内置在 `resources/bin/`）。

```powershell
npm install --save-dev electron ffmpeg-static
# 将锁定版本的工具放到应用查找的位置：
#   yt-dlp.exe     -> resources/yt-dlp.exe（或加入 PATH）
#   gallery-dl.exe -> resources/bin/gallery-dl.exe（或加入 PATH）
npx electron .
```

打包版从可执行文件旁的 `resources/bin/*.exe` 解析工具路径。

## 修改与打包方式

打包版无构建链，采用 asar 往返：

```powershell
npx asar extract C:\software\QingYingDownloader\resources\app.asar QingYingDownloader_src
# 修改源码后 node --check 校验
npx asar pack QingYingDownloader_src C:\software\QingYingDownloader\resources\app.asar
```

## 许可证

[MIT](LICENSE)

## 🤖 Agent API

应用运行期间，本地 HTTP 接口监听 `127.0.0.1:8392`。接口复用应用内的 yt-dlp / gallery-dl 引擎**与各站点登录会话**（抖音/TikTok/B站/小红书/Instagram 的 Cookie 注入），已登录站点的下载行为与界面一致。另有无头接口 `npm run agent:serve`（8793）把同一份引擎核心暴露成带 schema 的工具，并附 MCP stdio 桥。

| 路由 | 方法 | 请求体 | 返回 |
|---|---|---|---|
| `/health` | GET | — | 版本、引擎，以及守卫自己正在执行哪几条 |
| `/api/status` | GET | — | 接口自身的真实监听状态（在不在、端口、失败原因） |
| `/api/queue` | GET | — | 当前队列快照 |
| `/api/analyze` | POST | `{url}` + 令牌头 | 标题/作者/`videos[]` + `audios[]` 格式列表，或 gallery-dl 图片清单 |
| `/api/download` | POST | `{url, outputDir, mode: "combined"\|"video"\|"audio"\|"images", videoId?, audioId?, audioFormat?, images?}` + 令牌头 | `{files: [落盘路径]}` |

端口覆盖：`QINGYING_API_PORT`。

### 接口拒绝什么，以及为什么必须拒绝

接口是拿用户的登录会话去下载文件的，所以"只监听 127.0.0.1"并不是一条边界：本机任何进程、以及任何网页发出的跨源简单 POST，都打得到回环端口。两个接口因此走同一份守卫（`electron/local-guard.cjs`）：

- **只绑回环**：绑到非回环地址是直接拒绝，不是提醒。
- **`Host` 逐字白名单**：只认 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>`，其余 `403 HOST_NOT_ALLOWED`。Origin 判据从不与"请求自己的 Host"相比 —— 那个等式正是 DNS rebinding 自然产生的东西。
- **外部 `Origin`/`Referer` → `403` + JSON 错误体**：浏览器标签页驱动不了下载器。
- **所有非 GET 都要带令牌**：`x-qingying-token: <令牌>`（或 `Authorization: Bearer`）。令牌存在当前用户 app-data 的 `%APPDATA%\qingying-downloader\qingying\agent-api.token`，首次使用时按 `0600` 创建，所以 MCP 桥和命令行调用方不需要谁给它发环境变量也能继续工作；`QINGYING_API_TOKEN` 优先于文件。令牌读不出来也写不出来时写请求 fail-closed（`503 TOKEN_UNAVAILABLE`），绝不因为"没有密钥"就放开。
- **`outputDir` 被收住**：必须 realpath 之后落在用户指定的下载根目录之内 —— 也就是界面「保存位置」那个目录（`settings.outputDir`，另可加 `allowedOutputRoots` / `QINGYING_DOWNLOAD_ROOTS`）。其它一律拒绝（无关的绝对路径、`..\` 越界、根目录里一个指向外面的 junction），返回 `403 output_dir_outside_root`，消息里写清允许的根目录和怎么改；判定通过之前不创建任何目录。
- **状态变更路由没有通配 CORS**；返回值里只有状态、大小与路径。

Cookie 值从不出进程：`/health`、`/api/status`、Agent 工具与界面都只报登录状态、Cookie **名称**与过期时间。

## 许可证
