# 清影下载器 Agent API

把下载器的真实能力暴露成带 JSON Schema 的工具，供任意 Agent（Tcode、Claude Code、Codex、
任何 MCP 客户端）调用。契约见 `personal-agent-hub/docs/AGENT_API_STANDARD.md`，只监听 `127.0.0.1`。

## 启动

```bash
npm run agent:serve     # node agent/server.mjs（默认 8793，被占自动 +1 并写 agent/.endpoint）
npm run agent:mcp       # MCP stdio 桥；服务未起时按 agent/launch.json 自行拉起
```

```
GET  /api/health          健康与版本 + 守卫自己正在执行哪几条 + 桌面接口的真实状态
GET  /api/agent/tools     工具清单（name / description / input_schema / risk）
GET  /api/agent/manifest  项目元信息 + 工具清单
POST /api/agent/tool      唯一调用入口，body = {tool, input}，必须带 x-qingying-token
```

## 安全边界

判据只有一份：`electron/local-guard.cjs`，应用内接口（8392）与本服务（8793）共用。

- **只绑 `127.0.0.1`**；指定别的地址直接拒绝启动，不是警告。
- **`Host` 逐字白名单** `127.0.0.1:<端口> / localhost:<端口> / [::1]:<端口>`，否则 `403 HOST_NOT_ALLOWED`。
  Origin 判据**从不**与请求自己的 Host 相比 —— 那个等式正是 DNS rebinding 的结果。
- **外部 Origin/Referer → 403 + JSON 错误体**：网页不能驱动这个下载器（它带着用户的登录会话）。
- **非 GET 一律要本机令牌**（`x-qingying-token` 或 `Authorization: Bearer`）。令牌在
  `%APPDATA%\qingying-downloader\qingying\agent-api.token`，首次使用时按 `0600` 创建；
  MCP 桥先 `GET /api/health` 拿到这个路径再自己读，所以不带环境变量也能干活。
  `QINGYING_API_TOKEN` 优先于文件。令牌不可用时写请求 `503 TOKEN_UNAVAILABLE`（fail-closed）。
- **`qingying.download` 的 `output_dir` 被收住**：必须 realpath 之后落在用户指定的下载根目录之内
  （`settings.outputDir` + `allowed_output_roots`，或 `QINGYING_DOWNLOAD_ROOTS`）；越界返回
  `400 output_dir_outside_root` 并列出允许的根目录，判定通过前不创建任何目录。
  没有指定过下载根目录 = 一个字节都不写。
- **状态变更路由没有通配 CORS**（`OPTIONS` 回 `403 NO_CORS`）。
- **登录态只报状态，永不返回 Cookie 或凭据值。**
- 唯一写盘的 `qingying.download` 标 `risk: exec`，缺 `confirm: true` 时直接拒绝。

自检：`npm run agent:check`（真起服务、真打守卫四条与目录边界）与
`npm run verify`（`scripts/api-guard.test.cjs`：伪造 Host、外部 Origin、缺令牌、
越界 outputDir、以及"合法路径仍能走通"两侧都判）。

## 工具（8 个）

| 工具 | risk | 用途 |
| --- | --- | --- |
| `qingying.engines` | read | 探测 yt-dlp / gallery-dl 是否可用、版本、数据目录 —— 决定能不能干活先看它 |
| `qingying.parse` | read | 解析一个 URL，返回候选格式与元信息（真实调用引擎） |
| `qingying.download` | exec | 真实下载到磁盘，返回绝对路径与字节数。**必须显式 `confirm: true`** |
| `qingying.tasks` | read | 当前任务与进度 |
| `qingying.history` | read | 历史下载记录 |
| `qingying.auth_status` | read | 各站点登录态**状态**（Bilibili/Douyin/TikTok/Instagram/YouTube） |
| `qingying.settings` | read | 读应用设置 |
| `qingying.settings_set` | write | 写应用设置 |

引擎调用、任务队列与登录会话都复用应用自己的模块（`electron/engine-core.cjs` 等），
Agent 与桌面窗口看到的是同一套状态，不存在第二份实现。
