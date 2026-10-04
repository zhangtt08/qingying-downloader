// 清影下载器 Agent API — 本地 HTTP 服务，供外部 agent 以 tool 形式调用。
// 随桌面应用启动（main.cjs 在 app ready 时接线），复用应用内的 yt-dlp/gallery-dl
// 引擎与各站点登录会话（Cookie 注入依赖 Electron session，故不提供无 GUI 独立模式）。
// 端口：环境变量 QINGYING_API_PORT，默认 8392。仅监听 127.0.0.1。
//
// 安全边界（判据在 electron/local-guard.cjs，与独立 Agent 接口 8793 共用同一份实现）：
//   · Host 逐字白名单 + Origin/Referer 必须是本机回环 —— 挡 DNS rebinding 与跨源浏览器 POST；
//     本接口复用的是用户已登录的会话，任何网页都能 POST 就等于把登录态当写盘代理用；
//   · 非 GET 必须带本机令牌（值存在当前用户 app-data 的 0600 文件里，MCP 桥读同一份）；
//   · POST /api/download 的 outputDir 必须 realpath 之后落在用户指定的下载根目录之内；
//   · 任何响应都不发 Access-Control-Allow-Origin: *。
// Cookie 值任何时候都不进日志、不进响应。
'use strict';

const http = require('node:http');
const guard = require('./local-guard.cjs');

const DEFAULT_API_PORT = 8392;

// 输出目录核对由 engine core 负责（它按模板目录 + .part 过滤算出真实落盘文件），
// 这里只做请求体读写与路由。需要 Agent 标准接口（/api/agent/tools 等）请用
// agent/server.mjs —— 那个服务是无头的、复用同一个 electron/engine-core.cjs。
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (_) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, guard.localHeaders({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  }));
  res.end(body);
}

// 落盘核对（真实路径与字节数）由 engine core 在做，downloadMedia 走的是界面同一个队列，
// 因此这里不再自己列目录做差集 —— 那只会算出第二套不一致的结果。
// deps.resolveOutputDir(outputDir) 由 main.cjs 注入（它才知道当前设置里的下载根目录）。
function createAgentApiServer(deps) {
  const {
    analyzeMedia, downloadMedia, queueSnapshot,
    version = '', port = DEFAULT_API_PORT, token = '', tokenFile = '',
    resolveOutputDir, statusSnapshot,
  } = deps || {};

  async function handle(req, res) {
    // 守卫在最前：Host / Origin / Referer / 令牌，任何一条不过都不进业务分支。
    const verdict = guard.checkLocalGuard(req, { port, token, tokenFile });
    if (!verdict.ok) return guard.replyGuardDenied(res, verdict);

    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      return send(res, 200, {
        ok: true,
        tool: 'qingying-downloader',
        version,
        engine: ['yt-dlp', 'gallery-dl'],
        guard: {
          host_allowlist: `127.0.0.1:${port} / localhost:${port} / [::1]:${port}`,
          token_required: true,
          token_header: guard.TOKEN_HEADER,
          token_file: tokenFile,
          cookie_values_never_returned: true,
        },
        hint: 'POST /api/analyze {url}；POST /api/download {url, outputDir, mode, ...}（outputDir 必须在本机下载根目录之内）；GET /api/queue；GET /api/status',
      });
    }
    if (route === 'GET /api/queue') {
      return send(res, 200, { ok: true, data: typeof queueSnapshot === 'function' ? queueSnapshot() : null });
    }
    if (route === 'GET /api/status') {
      // 接口的真实状态（监听成功与否、端口、令牌是否必需）—— 不是"文档说它在"，是它自己报的。
      return send(res, 200, { ok: true, data: typeof statusSnapshot === 'function' ? statusSnapshot() : { listening: false, error: '主进程没有提供状态快照' } });
    }
    if (route === 'POST /api/analyze') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      const result = await analyzeMedia(body);
      return send(res, result.ok ? 200 : 502, result);
    }
    if (route === 'POST /api/download') {
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { ok: false, error: e.message }); }
      const outputDir = String(body.outputDir || '').trim();
      if (!outputDir) return send(res, 400, { ok: false, error: 'outputDir 不能为空' });
      // 任意绝对路径 = 任何本机进程（或曾经任何拿到令牌的调用方）都能把文件写到磁盘任何位置。
      // 现在只允许落在用户指定的下载根目录之内；拒绝时给的是"怎么改才能过"，不是一句 forbidden。
      if (typeof resolveOutputDir !== 'function') {
        return send(res, 503, { ok: false, error: '下载目录边界判定不可用（主进程没有注入 resolveOutputDir），本次不写盘' });
      }
      const target = resolveOutputDir(outputDir);
      if (!target || !target.ok) {
        return send(res, 403, {
          ok: false,
          error: (target && target.error) || '下载目录不被允许',
          code: (target && target.code) || 'output_dir_refused',
          download_roots: (target && target.roots) || [],
        });
      }
      const result = await downloadMedia(Object.assign({}, body, { outputDir: target.resolved || outputDir }));
      if (!result.ok) return send(res, result.cancelled ? 409 : 502, result);
      return send(res, 200, result);
    }
    return send(res, 404, { ok: false, error: `未知路由 ${route}，可用：GET /health、GET /api/queue、GET /api/status、POST /api/analyze、POST /api/download` });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { ok: false, error: err instanceof Error ? err.message : '内部错误' }));
  });
}

/**
 * 起来并交出真实结果。main.cjs 要把它拿到的 outcome 报给界面与 /api/status ——
 * 以前这里是 server.on('error', () => {}) 加一层空 catch，端口被占就静默没有接口。
 */
async function startAgentApi(deps) {
  const server = createAgentApiServer(deps);
  const outcome = await guard.listenLocal(server, Number((deps && deps.port) || DEFAULT_API_PORT), {
    host: (deps && deps.host) || '127.0.0.1',
    token: (deps && deps.token) || '',
  });
  outcome.server = server;
  return outcome;
}

module.exports = { createAgentApiServer, startAgentApi, DEFAULT_API_PORT, readBody };
