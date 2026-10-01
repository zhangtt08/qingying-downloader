#!/usr/bin/env node
// Agent API server — 标准实现，请勿改动逻辑。项目只需提供同目录下的 tools.mjs。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();

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

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
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

export async function start({ port: wantPort, host = '127.0.0.1', label = 'agent' } = {}) {
  const mod = await loadTools();
  const meta = mod.project || { name: label, version: '0.0.0' };
  const tools = mod.tools || [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const descriptor = (t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, risk: t.risk || 'read' });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || host}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
      if (route === '/api/health') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, agent_api: 1, tools: tools.length, uptime_ms: Date.now() - START } });
      } else if (route === '/api/agent/tools') {
        json(res, 200, { ok: true, data: tools.map(descriptor) });
      } else if (route === '/api/agent/manifest') {
        json(res, 200, { ok: true, data: { project: meta.name, version: meta.version, description: meta.summary || '', base_url: `http://${host}:${server.address().port}`, tools: tools.map(descriptor) } });
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
          json(res, e instanceof AgentError && e.code === 'bad_input' ? 400 : 500, { ok: false, tool: tool.name, error: { code, message: e.message } });
        }
      } else {
        json(res, 404, { ok: false, error: { code: 'not_found', message: `未知路径 ${route}`, endpoints: ['/api/health', '/api/agent/tools', '/api/agent/manifest', 'POST /api/agent/tool'] } });
      }
    } catch (e) {
      json(res, 500, { ok: false, error: { code: 'internal', message: e.message } });
    }
  });

  const endpointFile = path.join(__dirname, '.endpoint');
  const listen = (p, tries) => new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && tries > 0) resolve(listen(p + 1, tries - 1));
      else reject(e);
    });
    server.listen(p, host, () => resolve(server.address().port));
  });

  // 项目端口配置（AGENT_API_STANDARD 端口表：qingying = 8793）。
  // 这是本文件相对模板唯一改动处：只把兜底常量从 8790 换成本项目分配的端口，
  // 逻辑与响应形状逐字保留，因此 `node agent/server.mjs` 不需要环境变量就能起在 8793。
  const PROJECT_DEFAULT_PORT = 8793;
  const port = await listen(wantPort || server.address()?.port || PROJECT_DEFAULT_PORT, 12);
  writeFileSync(endpointFile, `http://${host}:${port}\n`);
  console.log(`[agent] ${meta.name} v${meta.version} → http://${host}:${port} (${tools.length} tools)`);
  return { server, port, url: `http://${host}:${port}`, tools: tools.map(descriptor) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envPort = Number(process.env.AGENT_PORT || process.env.PORT || 0) || undefined;
  start({ port: envPort }).catch((e) => { console.error('[agent] 启动失败：', e.message); process.exit(1); });
}
