# 清影下载器 Agent API

把下载器的真实能力暴露成带 JSON Schema 的工具，供任意 Agent（Tcode、Claude Code、Codex、
任何 MCP 客户端）调用。契约见 `personal-agent-hub/docs/AGENT_API_STANDARD.md`，只监听 `127.0.0.1`。

## 启动

```bash
npm run agent:serve     # node agent/server.mjs（默认 8793，被占自动 +1 并写 agent/.endpoint）
npm run agent:mcp       # MCP stdio 桥；服务未起时按 agent/launch.json 自行拉起
```

```
GET  /api/health          健康与版本
GET  /api/agent/tools     工具清单（name / description / input_schema / risk）
GET  /api/agent/manifest  项目元信息 + 工具清单
POST /api/agent/tool      唯一调用入口，body = {tool, input}
```

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

## 安全边界

- 只绑 `127.0.0.1`。
- **登录态只报状态，永不返回 Cookie 或凭据值。**
- 唯一写盘的 `qingying.download` 标 `risk: exec`，缺 `confirm: true` 时只返回计划不下载。
