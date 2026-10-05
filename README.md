# qingying-downloader (清影下载器)

A Windows desktop downloader that pairs **yt-dlp** (video) with **gallery-dl** (images) — with one-click cookie login for Bilibili, Douyin, TikTok, Instagram and Xiaohongshu.
Windows 桌面视频/图片下载器：yt-dlp / gallery-dl 双引擎，B站 / 抖音 / TikTok / Instagram / 小红书一键登录会话。

Sites like Bilibili (risk control), Douyin (`modal_id` URLs), TikTok (anti-crawler JS challenge) and Instagram (forced login) break naive command-line downloads. **qingying-downloader** wraps both engines in an Electron GUI, keeps a per-site login session in a persisted browser partition, injects those cookies into every engine call, and automatically falls back from yt-dlp to gallery-dl when a link turns out to be images.

[中文说明](README.zh-CN.md)

![License](https://img.shields.io/badge/license-MIT-green)
![Platform](https://img.shields.io/badge/platform-Windows-blueviolet)
![Electron](https://img.shields.io/badge/Electron-47848F?logo=electron&logoColor=white)
![yt-dlp](https://img.shields.io/badge/engine-yt--dlp-642CA9)
![gallery-dl](https://img.shields.io/badge/engine-gallery--dl-44A833)
![ffmpeg](https://img.shields.io/badge/ffmpeg-6.1.1-007808?logo=ffmpeg&logoColor=white)

## ✨ Features

- **Dual engine** — yt-dlp for video; gallery-dl takes over automatically for images when yt-dlp fails or returns nothing
- **Format picker** — separate video / audio stream selection with optional ffmpeg merge
- **Five login sessions** — Bilibili, Douyin, TikTok, Instagram, Xiaohongshu: log in once in the in-app window; cookies are injected into engine calls (helps when Bilibili risk control blocks anonymous API access)
- **YouTube and beyond** — public YouTube links and anything else yt-dlp supports work without login
- **TikTok anti-crawl** — built-in browser UA to pass the anti-crawler JS challenge
- **Reliable image saving** — files are written via Node's native `https` module instead of Electron's `net.fetch`, which can hang on large downloads
- **Download queue with progress**

## 🔒 Pinned tool versions

Do not bump these casually — newer releases are known to regress:

| Tool | Version | Reason |
|---|---|---|
| yt-dlp | 2026.07.04 | The 2026.08.19 build breaks TikTok parsing in practice and does not fix Bilibili HTTP 412 |
| gallery-dl | 1.31.10 | Newer releases no longer ship a Windows exe |
| ffmpeg | 6.1.1 | Reuses the copy bundled with the packaged app |

## 🏗️ Architecture

```
electron/main.cjs        Main process — window, IPC, download queue, cookie injection, API startup
electron/engine-core.cjs Shared engine core: both the UI and the agent APIs call this (analysis, args, progress, storage, path guards)
electron/local-guard.cjs The one local-service guard both APIs run through (Host / Origin / token / loopback bind)
electron/agent-api.cjs   In-app HTTP API (127.0.0.1:8392) — reuses the running app's engines and sessions
electron/preload.cjs     Preload bridge (named methods only, no node in the renderer)
agent/server.mjs         Standalone headless Agent API (127.0.0.1:8793)
agent/tools.mjs          Its 8 schema'd tools            agent/mcp-server.mjs  MCP stdio bridge
renderer/                UI (index.html / app.js / styles.css / icons)
scripts/check.cjs        npm run check — static + core behaviour assertions
scripts/verify.cjs       npm run verify — behavioural gates (guard, docs-vs-code)
scripts/build.cjs        npm run build / npm run dist — pack + assemble + artifact assertions
```

Pipeline: renderer → IPC → URL normalization (e.g. Douyin share links) → engine selection (yt-dlp for video, gallery-dl fallback for images) → format list → download queue with progress events → ffmpeg merge if needed.

## 🚀 Getting started

This repository is the app source (it is what gets packed into `resources/app.asar`), and it has a real build chain — `npm run build` to validate and assemble, `npm run dist` to also produce an installer.

Run from source (Windows):

```powershell
git clone https://github.com/zhangtt08/qingying-downloader.git
cd qingying-downloader
npm install     # devDependencies: electron 37.10.3, @electron/asar, electron-builder
npm start       # same thing as: npx electron .
```

The engine binaries (yt-dlp / gallery-dl / ffmpeg) are **not** in this repo — `/resources/` is gitignored, and the pinned exes belong to the machine or to the installer. Put them in `resources/bin/` (or on `PATH`), or point 设置 → 指定引擎目录 at the folder that already has them. Without them the app reports each engine as 未安装 instead of pretending. `npm install ffmpeg-static` is optional: `main.cjs` requires it inside a `try/catch`, so its absence only removes that fallback.

### Build and package

| Command | What it produces |
|---|---|
| `npm run build` | `dist/app.asar` (drop-in replacement for the packaged app's `resources/app.asar`) and `dist/win-unpacked/` — an unpacked, runnable app dir whose executable is `清影下载器.exe`; `resources/bin/*.exe` is copied in when those engines are present, and its absence is printed instead of hidden |
| `npm run dist` | the same, plus the NSIS installer `dist/qingying-downloader-<version>-win-x64.exe` (measured here: 89 MB, Electron 37.10.3) |

Both are the same script (`scripts/build.cjs`, one extra flag), every step prints PASS/FAIL, and the build checks its own output: the bytes inside the produced asar must equal the repo sources, and no settings/history/cookie file may enter an artifact. `dist/` is gitignored, so building never dirties the tree.

The old instructions in this file pointed at `npx asar extract C:\software\QingYingDownloader\resources\app.asar` — a path that exists only on one other machine, and there was no script behind it. They are gone: to patch an existing install in place, run `npm run build` and copy `dist/app.asar` over that install's `resources/app.asar`.


## 📄 License

[MIT](LICENSE)

## 🤖 Agent API

While the app is running, a local HTTP API is available on `127.0.0.1:8392`. It reuses the app's yt-dlp / gallery-dl engines **and its per-site login sessions** (Douyin / TikTok / Bilibili / Xiaohongshu / Instagram cookies), so logged-in downloads work the same as in the UI. A second, headless agent surface (`npm run agent:serve`, port `8793`) exposes the same engine core as schema'd tools plus an MCP stdio bridge.

| Endpoint | Method | Body | Result |
|---|---|---|---|
| `/health` | GET | — | version + engines + what the guard itself enforces |
| `/api/status` | GET | — | the API's real bind state (listening / port / error) |
| `/api/queue` | GET | — | current queue snapshot |
| `/api/analyze` | POST | `{url}` + token header | title / uploader / `videos[]` + `audios[]` formats, or a gallery-dl image list |
| `/api/download` | POST | `{url, outputDir, mode: "combined"\|"video"\|"audio"\|"images", videoId?, audioId?, audioFormat?, images?}` + token header | `{files: [saved paths]}` |

Port override: `QINGYING_API_PORT`.

### How many downloads run at once (measured, not aspirational)

Concurrency comes from one place: `settings.concurrency`, **default 2, configurable 1–4** (`DEFAULT_SETTINGS.concurrency` in `electron/engine-core.cjs`, clamped by `clampInt(value, 1, 4, 2)`; the same selector as the UI's 并发 field). `pumpQueue()` in `electron/main.cjs` starts queued tasks while fewer than that many are in flight; the rest stay `queued`.

`POST /api/download` enqueues into that same queue and returns when **its own** task reaches a terminal state, so a request that arrives while another download is running is **not** rejected: there is no "one at a time" limit and **no 409 on collision**. Status codes are only these: `200` task done, `403` the guard or the download-root check refused the request, `409` *this* task ended cancelled/paused, `502` the engine failed. Two callers waiting in parallel is the normal case, not an error.

The headless agent on `8793` is a separate process: it shares `settings.json`/`history.json` with the UI but runs each `qingying.download` inline in its own process, so the app's `concurrency` number does not throttle it — N simultaneous requests there mean N engine calls.

### What the local API refuses, and why it can

The API downloads with the user's logged-in sessions, so "it only binds 127.0.0.1" is not a boundary — any local process, and any web page via a cross-origin POST, can reach a loopback port. Both surfaces therefore run the same guard (`electron/local-guard.cjs`):

- **Loopback only** — binding to a non-loopback host is refused outright, not warned about.
- **Literal `Host` allowlist** — `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>`; anything else gets `403 HOST_NOT_ALLOWED`. The Origin check is never compared against the request's own Host, because that equality is exactly what DNS rebinding produces.
- **Foreign `Origin`/`Referer` → `403` with a JSON body** — a browser tab cannot drive the downloader.
- **Token on every non-GET** — `x-qingying-token: <token>` (or `Authorization: Bearer`). The token lives in per-user app-data at `%APPDATA%\qingying-downloader\qingying\agent-api.token`, created with mode `0600` on first use, so the MCP bridge and CLI callers keep working without anyone exporting an environment variable. `QINGYING_API_TOKEN` overrides the file. If the token cannot be read or created, writes fail closed with `503 TOKEN_UNAVAILABLE` — the absence of a secret never opens the door.
- **`outputDir` is contained** — it must resolve (after `realpath`) inside a download root the user designated, i.e. the folder in the app's 保存位置 setting (`settings.outputDir`, plus optional `allowedOutputRoots` / `QINGYING_DOWNLOAD_ROOTS`). Anything else — an unrelated absolute path, `..\` traversal, a junction inside the root pointing outside it — is refused with `403 output_dir_outside_root`, and the message names the allowed roots and how to change them. No directory is created before the check passes.
- **No wildcard CORS** on mutating routes; nothing is echoed back except status, sizes and paths.

Cookie values never leave the process: `/health`, `/api/status`, the agent tools and the UI report login state, cookie *names* and expiry only.


## 📄 License
