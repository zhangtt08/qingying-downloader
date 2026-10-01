// 清影下载器 Agent API — 本地 HTTP 服务，供外部 agent 以 tool 形式调用。
// 随桌面应用启动（main.cjs 在 app ready 时接线），复用应用内的 yt-dlp/gallery-dl
// 引擎与各站点登录会话（Cookie 注入依赖 Electron session，故不提供无 GUI 独立模式）。
// 端口：环境变量 QINGYING_API_PORT，默认 8392。仅监听 127.0.0.1。
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_API_PORT = 8392;

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
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// 输出目录快照差集：下载结束后报告新增的文件（yt-dlp/gallery-dl 不直接回传落盘路径）。
function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.join(dir, e.name));
  } catch (_) {
    return [];
  }
}

function diffFiles(before, after) {
  const seen = new Set(before);
  return after.filter((f) => !seen.has(f));
}

function createAgentApiServer({ analyzeMedia, downloadMedia, version = '' } = {}) {
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /health') {
      return send(res, 200, {
        ok: true,
        tool: 'qingying-downloader',
        version,
        engine: ['yt-dlp', 'gallery-dl'],
        hint: 'POST /api/analyze {url}；POST /api/download {url, outputDir, mode, ...}',
      });
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
      const before = listDir(outputDir);
      const result = await downloadMedia(body);
      if (!result.ok) return send(res, result.cancelled ? 409 : 502, result);
      const files = diffFiles(before, listDir(outputDir));
      return send(res, 200, { ...result, data: { files } });
    }
    return send(res, 404, { ok: false, error: `未知路由 ${route}，可用：GET /health、POST /api/analyze、POST /api/download` });
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, { ok: false, error: err instanceof Error ? err.message : '内部错误' }));
  });
}

module.exports = { createAgentApiServer, DEFAULT_API_PORT };
