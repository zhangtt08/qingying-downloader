#!/usr/bin/env node
// Agent API server — 标准实现的项目本地副本；契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
//
// 本机服务守卫（electron/local-guard.cjs，与应用内接口 8392 同一份判据，不写第二遍）：
//   只绑 127.0.0.1 · Host 逐字白名单（挡 DNS rebinding）· Origin/Referer 出现就必须是本机回环
//   · 非 GET 必须带本机令牌（存在当前用户 app-data 的 0600 文件里，MCP 桥读同一份）
//   · 状态变更路由永不发 Access-Control-Allow-Origin: *
// 守卫模块读不出来时按 fail-closed 处理：只读端点照常，任何写请求一律拒绝并说清原因。
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();

/** 载入共享守卫；返回 null 表示文件缺失（这时写请求会被拒绝，不是放开） */
export function loadGuard() {
  try {
    return require(path.resolve(__dirname, '..', 'electron', 'local-guard.cjs'));
  } catch {
    return null;
  }
}

export class AgentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function loadTools() {
  const p = path.join(__dirname, 'tools.mjs');
  if (!existsSync(p)) throw new Error(`missing ${p}: 项目必须实现 agent/tools.mjs`);
  return import(`file:///${p.replace(/\\/g, '/')}`);
}

function json(res, status, body, headers = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  // 状态变更路由上带 ACAO:* 等于告诉浏览器"任意站点都能来 POST 我"，这里一个都不发。
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new AgentError('too_large', '请求体超过 8MB')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new AgentError('bad_json', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// 只校验 required 与未知键；类型宽松处理，交给业务 handler 自己收窄。
function validate(schema, input) {
  if (!schema || schema.type !== 'object') return;
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = (schema.required || []).filter((k) => data[k] === undefined || data[k] === null || data[k] === '');
  if (missing.length) throw new AgentError('bad_input', `缺少必填参数：${missing.join(', ')}`);
  if (schema.additionalProperties === false) {
    const unknown = Object.keys(data).filter((k) => !(k in (schema.properties || {})));
    if (unknown.length) throw new AgentError('bad_input', `未知参数：${unknown.join(', ')}；可用：${Object.keys(schema.properties || {}).join(', ') || '无'}`);
  }
}

// 桌面应用内接口（8392）的真实状态：由主进程写在 app-data 里，读不到就是"没在跑"，
// 不拿文档里那句"监听在 8392"当现状。
function readDesktopApiStatus(file) {
  if (!file) return { available: false, note: '没有状态文件路径' };
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (!state || typeof state !== 'object') return { available: false, note: '状态文件不是对象' };
    return { available: true, ...state };
  } catch (error) {
    const missing = error && error.code === 'ENOENT';
    return {
      available: false,
      listening: false,
      note: missing
        ? '桌面应用没有写过状态文件（应用可能没在运行，或版本不支持）'
        : `状态文件读不出来：${error && error.message ? error.message : String(error)}`,
      file,
    };
  }
}

export async function start({ port: wantPort, host = '127.0.0.1', label = 'agent', token: tokenOverride } = {}) {
  const mod = await loadTools();
  const meta = mod.project || { name: label, version: '0.0.0' };
  const tools = mod.tools || [];
  const cfg = mod.agentConfig || {};
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptor = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk || 'read' });

  const guard = loadGuard();
  if (!guard) {
    console.error('[agent] 读不到 electron/local-guard.cjs —— 写请求将被拒绝（fail-closed）。请确认仓库完整。');
  }
  const tokenFile = cfg.tokenFile || '';
  const tokenInfo = guard
    ? (tokenOverride ? { token: String(tokenOverride).trim(), source: 'caller', file: tokenFile, error: '' } : guard.resolveApiToken({ tokenFile }))
    : { token: '', source: 'guard_missing', file: tokenFile, error: '守卫模块缺失' };
  if (tokenInfo.error) console.error(`[agent] 本机令牌不可用：${tokenInfo.error} —— 写请求会被拒绝，直到它可用`);
  const tokenHeader = String(cfg.tokenHeader || (guard && guard.TOKEN_HEADER) || 'x-qingying-token').toLowerCase();

  const server = createServer(async (req, res) => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr && typeof addr.port === 'number'
      ? addr.port
      : Number(wantPort) || 8793;
    // 守卫在最前：Host / Origin / Referer / 令牌，任何一条不过都不进业务分支。
    if (guard) {
      const verdict = guard.checkLocalGuard(req, { port, token: tokenInfo.token, tokenFile, tokenHeader });
      if (!verdict.ok) { guard.replyGuardDenied(res, verdict); return; }
    } else if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 503, { ok: false, error: { code: 'GUARD_UNAVAILABLE', message: '守卫模块缺失（electron/local-guard.cjs），写请求按 fail-closed 拒绝。请恢复该文件后重启本服务。' } });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') { json(res, 403, { ok: false, error: { code: 'NO_CORS', message: '本机服务不做跨源放行；请把请求直接打到 127.0.0.1:' + port + '，并带上本机令牌' } }); return; }
      if (route === '/api/health') {
        json(res, 200, { ok: true, data: {
          project: meta.name, version: meta.version, agent_api: 1, tools: tools.length, uptime_ms: Date.now() - START,
          guard: {
            host_allowlist: `127.0.0.1:${port} / localhost:${port} / [::1]:${port}`,
            token_required: true,
            token_available: Boolean(tokenInfo.token),
            token_source: tokenInfo.source,
            token_header: tokenHeader,
            token_file: tokenFile,
          },
          desktop_api: readDesktopApiStatus(cfg.desktopApiStatusFile),
        } });
      } else if (route === '/api/agent/tools') {
        json(res, 200, { ok: true, data: tools.map(descriptor) });
      } else if (route === '/api/agent/manifest') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, description: meta.summary || '', base_url: `http://${host}:${server.address().port}`, tools: tools.map(descriptor), api: { token_header: tokenHeader, token_file: tokenFile } } });
      } else if (route === '/api/agent/tool' && req.method === 'POST') {
        const body = await readBody(req);
        const tool = byName.get(body.tool);
        // 未注册的工具必须在这里就回完并 return：落进下面的 try 会在已结束的响应上二次发送，
        // 把 keep-alive 连接打坏，后续请求全部 ECONNRESET。
        if (!tool) { json(res, 400, { ok: false, error: { code: 'unknown_tool', message: `未注册的工具：${body.tool}`, available: [...byName.keys()] } }); return; }
        try {
          const t0 = Date.now();
          validate(tool.input_schema, body.input);
          const data = await tool.handler(body.input || {}, { meta, host, port: server.address().port });
          json(res, 200, { ok: true, tool: tool.name, ms: Date.now() - t0, data });
        } catch (e) {
          const code = e instanceof AgentError ? e.code : 'handler_failed';
          const badRequest = e instanceof AgentError && ['bad_input', 'confirm_required', 'output_dir_outside_root',
            'output_dir_missing', 'output_dir_not_absolute', 'no_download_root', 'output_dir_create_failed'].includes(e.code);
          json(res, badRequest ? 400 : 500, { ok: false, tool: tool.name, error: { code, message: e.message } });
        }
      } else {
        json(res, 404, { ok: false, error: { code: 'not_found', message: `未知路径 ${route}`, endpoints: ['/api/health', '/api/agent/tools', '/api/agent/manifest', 'POST /api/agent/tool'] } });
      }
    } catch (e) {
      // 调用方修得了的问题不能报 500：坏 JSON、超大 body、缺必填都是调用方的错，
      // 回 5xx 会让 Agent 以为"服务坏了"而反复重试，永远学不会改那行 body。
      const code = e instanceof AgentError ? e.code : 'internal';
      const callerFixable = e instanceof AgentError && ['bad_json', 'too_large', 'bad_input', 'unknown_tool', 'not_found'].includes(e.code);
      json(res, callerFixable ? 400 : 500, { ok: false, error: { code, message: e.message } });
    }
  });

  const endpointFile = process.env.AGENT_ENDPOINT_FILE || path.join(__dirname, '.endpoint');
  // 绑定：只走 127.0.0.1，失败要交出真实原因（code + 一句照着能做的中文），
  // 端口被占按标准往后试最多 12 次，但试完还是失败就把这一句抛给调用方。
  const bindOnce = (p) => {
    if (guard) return guard.listenLocal(server, p, { host, token: tokenInfo.token });
    return new Promise((resolve) => {
      const done = (ok, code, message) => resolve({
        ok,
        code,
        host,
        port: p,
        url: ok ? `http://${host}:${p}` : '',
        error: message || '',
      });
      server.once('error', (e) => done(false, (e && e.code) || 'LISTEN_FAILED',
        e && e.code === 'EADDRINUSE'
          ? `端口 ${p} 已被别的程序占用，接口没有起来。用环境变量 AGENT_PORT 换一个端口，或先关掉占用 ${p} 的程序：netstat -ano | findstr :${p}`
          : `接口未能监听 ${host}:${p}：${e && e.message ? e.message : String(e)}`));
      server.listen(p, host, () => done(true, '', ''));
    });
  };
  const bindWithFallback = async (p, tries) => {
    const outcome = await bindOnce(p);
    if (outcome.ok) return outcome;
    if (tries > 0 && outcome.code === 'EADDRINUSE') {
      server.removeAllListeners('error');
      return bindWithFallback(p + 1, tries - 1);
    }
    return outcome;
  };

  // 项目端口配置（AGENT_API_STANDARD 端口表：qingying = 8793）。
  const PROJECT_DEFAULT_PORT = 8793;
  const outcome = await bindWithFallback(wantPort || PROJECT_DEFAULT_PORT, 12);
  if (!outcome.ok) {
    throw Object.assign(new Error(outcome.error), { code: 'AGENT_BIND_FAILED' });
  }
  const port = outcome.port;
  try {
    writeFileSync(endpointFile, `http://${host}:${port}\n`);
  } catch (error) {
    console.error(`[agent] 端点文件 ${endpointFile} 写不下去（${error && error.message ? error.message : error}），MCP 桥需要环境变量 AGENT_BASE_URL`);
  }
  console.log(`[agent] ${meta.name} v${meta.version} → http://${host}:${port} (${tools.length} tools，非 GET 需本机令牌)`);
  return {
    server,
    port,
    url: `http://${host}:${port}`,
    tools: tools.map(descriptor),
    guard: { token_required: true, token_source: tokenInfo.source, token_file: tokenFile, token_header: tokenHeader, token_error: tokenInfo.error },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AGENT_PORT || process.env.PORT || 0) || undefined;
  start({ port: envPort }).catch((e) => {
    console.error('[agent] 启动失败：', e.message);
    if (e && e.code && e.code !== 'AGENT_BIND_FAILED') console.error('[agent] 错误码：', e.code);
    process.exit(1);
  });
}
