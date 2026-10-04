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
electron/main.cjs      Main process — engine dispatch, format parsing, download queue, cookie injection
electron/preload.cjs   Preload bridge
renderer/              UI (index.html / app.js / styles.css / icons)
```

Pipeline: renderer → IPC → URL normalization (e.g. Douyin share links) → engine selection (yt-dlp for video, gallery-dl fallback for images) → format list → download queue with progress events → ffmpeg merge if needed.

## 🚀 Getting started

> This repository is the extracted source of the packaged app; the packaged build bundles yt-dlp / gallery-dl / ffmpeg under `resources/bin/`. Use the packaged version if you just want to download files.

Run from source (Windows):

```powershell
git clone https://github.com/zhangtt08/qingying-downloader.git
cd qingying-downloader
npm install --save-dev electron ffmpeg-static
# place the pinned exes where the app looks for them:
#   yt-dlp.exe     -> resources/yt-dlp.exe   (or on PATH)
#   gallery-dl.exe -> resources/bin/gallery-dl.exe (or on PATH)
npx electron .
```

The packaged app resolves tools from `resources/bin/*.exe` next to the executable.

### This repo's asar workflow (no build chain)

The packaged app has no build step; source edits go back and forth through asar:

```powershell
npx asar extract C:\software\QingYingDownloader\resources\app.asar QingYingDownloader_src
# after editing, syntax-check with node --check
npx asar pack QingYingDownloader_src C:\software\QingYingDownloader\resources\app.asar
```

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
