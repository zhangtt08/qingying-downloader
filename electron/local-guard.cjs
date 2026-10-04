'use strict';
// 本机接口守卫 —— 应用内 REST(127.0.0.1:8392) 与独立 Agent API(127.0.0.1:8793) 共用这一份实现。
// 判据镜像 frameboost/electron/local-guard.ts（本机服务守卫标准），一个字节都不另写一套：
//   1) 只准绑 127.0.0.1（绑别的地址直接拒绝，不是"提醒一下"）；
//   2) Host 头逐字白名单：127.0.0.1:<port> / localhost:<port> / [::1]:<port>，否则 403（挡 DNS rebinding）；
//   3) Origin / Referer 只要出现就必须落在本机回环；
//      ⚠ 绝不拿 Origin 去和"请求自己的 Host"比 —— 那正是 DNS rebinding 的洞
//      （页面把域名解析到 127.0.0.1 后两者自然相等，闸门形同没有）；
//   4) 非 GET 必须带本机令牌（定长时间比较）。令牌持久化在当前用户 app-data 里的 0600 文件，
//      MCP 桥与命令行工具不需要环境变量也能继续工作（它们和本机服务读同一份）；
//   5) 任何响应都不发 Access-Control-Allow-Origin: *，状态变更路由尤其。
// 拿不到令牌时是 fail-closed：写请求一律拒绝并说清原因，绝不"记个日志继续跑"。
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TOKEN_ENV = 'QINGYING_API_TOKEN';
const TOKEN_HEADER = 'x-qingying-token';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function localApiToken(env) {
  return String((env || process.env)[TOKEN_ENV] ?? '').trim();
}

/** 拆开 "host:port"（IPv6 形如 [::1]:8392），返回 { host, port|null } */
function splitHostPort(value) {
  const s = String(value == null ? '' : value).trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end < 0) return { host: s, port: null };
    const host = s.slice(0, end + 1);
    const rest = s.slice(end + 1);
    const m = /^:(\d+)$/.exec(rest);
    return { host, port: m ? Number(m[1]) : null };
  }
  const idx = s.lastIndexOf(':');
  if (idx < 0) return { host: s, port: null };
  const maybePort = Number(s.slice(idx + 1));
  if (!Number.isFinite(maybePort)) return { host: s, port: null };
  return { host: s.slice(0, idx), port: maybePort };
}

/** Host 判据：主机名在本机白名单里，并且端口就是本服务实际监听的端口 */
function hostAllowed(host, port) {
  if (!host) return false;
  const { host: h, port: p } = splitHostPort(String(host));
  if (p !== port) return false;
  const normalized = h.replace(/^\[|\]$/g, '');
  const withBrackets = normalized === '::1' ? '[::1]' : normalized;
  return LOOPBACK_HOSTS.has(normalized.toLowerCase()) || LOOPBACK_HOSTS.has(withBrackets.toLowerCase());
}

/**
 * Origin/Referer 判据：没带 = 放行（命令行工具、node fetch 都不带）；带了就必须落在本机回环上。
 * 注意比较对象是**固定的本机白名单**，不是 req.headers.host —— 后者正是 DNS rebinding 能伪造的那一半。
 */
function originAllowed(origin) {
  if (origin === undefined || origin === null || String(origin).trim() === '') return true;
  const s = String(origin).trim();
  // file:// 与 "null" 是本地 HTML 打开的页面，看起来像本机但完全不可验证 → 拒。
  if (s === 'null' || s === 'file://') return false;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
  const explicit = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  return Number.isFinite(explicit) && explicit > 0;
}

/** 定长时间比较：先把两侧都哈希成固定 32 字节，连长度本身都不泄露 */
function tokenMatches(provided, expected) {
  if (!expected) return false;
  const a = createHash('sha256').update(String(provided == null ? '' : provided), 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function bearerOf(header) {
  const s = String(header == null ? '' : header);
  const m = /^Bearer\s+(.+)$/i.exec(s.trim());
  return m ? m[1].trim() : '';
}

/**
 * 唯一的守卫入口。返回 { ok:false } 时调用方必须先把它回出去再 return。
 * opts.token 为空视为"令牌不可用"，非 GET 走 fail-closed（503），不是放开。
 */
function checkLocalGuard(req, opts) {
  const port = Number(opts && opts.port) || 0;
  if (!hostAllowed(req.headers.host, port)) {
    return {
      ok: false,
      status: 403,
      code: 'HOST_NOT_ALLOWED',
      error: 'Host 头不被允许：本机服务只接受 127.0.0.1:' + port + ' / localhost:' + port + ' / [::1]:' + port
        + '（这一条挡的是 DNS rebinding）。请把请求指到这些地址',
    };
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && !originAllowed(origin)) {
    return {
      ok: false,
      status: 403,
      code: 'ORIGIN_NOT_ALLOWED',
      error: 'Origin 不是本机来源：' + origin.slice(0, 160) + '。本接口只服务本机回环调用，不从网页里直接调用',
    };
  }
  const referer = req.headers.referer || req.headers.referrer;
  if (typeof referer === 'string' && referer && !originAllowed(referer)) {
    return {
      ok: false,
      status: 403,
      code: 'REFERER_NOT_ALLOWED',
      error: 'Referer 不是本机来源：' + referer.slice(0, 160),
    };
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return { ok: true };
  const token = String((opts && opts.token) || '').trim();
  if (!token) {
    return {
      ok: false,
      status: 503,
      code: 'TOKEN_UNAVAILABLE',
      error: '本机令牌当前不可用（读取或创建 ' + ((opts && opts.tokenFile) || TOKEN_ENV)
        + ' 失败），写请求按 fail-closed 拒绝。请确认本用户对自己的 app-data 目录有写权限后重启本服务',
    };
  }
  const headerName = String((opts && opts.tokenHeader) || TOKEN_HEADER).toLowerCase();
  const direct = req.headers[headerName];
  let provided = '';
  if (typeof direct === 'string') provided = direct.trim();
  else if (Array.isArray(direct)) provided = String(direct[0] || '').trim();
  if (!provided) provided = bearerOf(req.headers.authorization);
  if (!tokenMatches(provided, token)) {
    return {
      ok: false,
      status: 401,
      code: 'TOKEN_REQUIRED',
      error: '缺少或错误的本机令牌：请带请求头 ' + headerName + ': <令牌>。令牌存在本用户 app-data 的 '
        + ((opts && opts.tokenFile) || 'agent-api.token') + '（0600），或设环境变量 ' + TOKEN_ENV,
    };
  }
  return { ok: true };
}

/**
 * 把拒绝理由回成 JSON。刻意不带任何 Access-Control-Allow-* 头：
 * 状态变更路由上发 ACAO:* 等于告诉浏览器"任意站点都可以来 POST 我"。
 */
function replyGuardDenied(res, verdict) {
  const body = JSON.stringify({
    ok: false,
    error: { code: verdict.code || 'FORBIDDEN', message: verdict.error || '请求被本机守卫拒绝' },
  });
  res.writeHead(verdict.status || 403, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/** 统一的本机响应头：永不出现 ACAO:* */
function localHeaders(extra) {
  const h = Object.assign({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, extra || {});
  for (const key of Object.keys(h)) {
    if (/^access-control-allow-origin$/i.test(key)) delete h[key];
    else if (/^access-control-allow-/i.test(key) && String(h[key]).trim() === '*') delete h[key];
  }
  return h;
}

// ── 令牌持久化（per-user app-data，0600）────────────────────────────────────
// 环境变量优先；没有就用/建 app-data 里那份，好让 MCP 桥、命令行工具和本机服务读到同一个值。
// Windows 上 mode:0600 只是请求（NTFS 真正的隔离靠该用户目录的 ACL），与本项目
// 导出 Cookie 文件时用的是同一套约定，README「数据放在本机哪里」一节已如实写明。
function readTokenFile(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{16,128}$/i.test(value) ? value : '';
  } catch {
    return '';
  }
}

function resolveApiToken(options) {
  const opts = options || {};
  const fromEnv = localApiToken(opts.env);
  const file = opts.tokenFile || '';
  if (fromEnv) {
    return { token: fromEnv, source: 'env', file, error: '' };
  }
  if (!file) {
    return { token: '', source: 'missing', file: '', error: '没有令牌文件路径，也没有 ' + TOKEN_ENV };
  }
  const existing = readTokenFile(file);
  if (existing) return { token: existing, source: 'file', file, error: '' };
  const token = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (error) {
    return { token: '', source: 'error', file, error: '无法写入令牌文件 ' + file + '：' + (error && error.message ? error.message : String(error)) };
  }
  return { token, source: 'created', file, error: '' };
}

// ── 绑定：只准绑 127.0.0.1，绑不上要如实报，绝不写 on('error', () => {}) ──────
function describeBindError(err, port) {
  const e = err || {};
  const code = String(e.code || '');
  if (code === 'EADDRINUSE') {
    return '端口 ' + port + ' 已被别的程序占用，接口没有起来。用环境变量 QINGYING_API_PORT'
      + '（独立 Agent 接口用 AGENT_PORT）换一个端口，或先关掉占用 ' + port + ' 的程序：netstat -ano | findstr :' + port;
  }
  if (code === 'EACCES') {
    return '端口 ' + port + ' 在本机被系统占用或需要管理员权限，接口没有起来。换一个 1024 以上的端口（QINGYING_API_PORT）';
  }
  return '接口未能监听 127.0.0.1:' + port + '：' + (e.message || String(err));
}

/**
 * 绑定并交出真实结果：成功给地址，失败给一句能照着做的话。
 * 这条函数存在的意义就是"失败必须有返回值"，而不是像以前一样被空 catch 吃掉。
 */
function listenLocal(server, port, opts) {
  const options = opts || {};
  const host = options.host || '127.0.0.1';
  const tokenRequired = true;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return Promise.resolve({ ok: false, code: 'HOST_NOT_LOOPBACK', host, port, url: '', error: '只允许监听本机回环（127.0.0.1），拒绝绑定到 ' + host, tokenRequired });
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    server.once('error', (err) => done({
      ok: false,
      code: (err && err.code) || 'LISTEN_FAILED',
      host,
      port,
      url: '',
      error: describeBindError(err, port),
      tokenRequired,
    }));
    server.listen(port, host, () => {
      const addr = server.address();
      const realPort = addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr.port : port;
      done({ ok: true, code: '', host, port: realPort, url: 'http://' + host + ':' + realPort, error: '', tokenRequired });
    });
  });
}

module.exports = {
  TOKEN_ENV,
  TOKEN_HEADER,
  LOOPBACK_HOSTS,
  localApiToken,
  splitHostPort,
  hostAllowed,
  originAllowed,
  tokenMatches,
  checkLocalGuard,
  replyGuardDenied,
  localHeaders,
  readTokenFile,
  resolveApiToken,
  describeBindError,
  listenLocal,
};
