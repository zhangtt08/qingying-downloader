'use strict';
// 清影下载器 — 引擎核心（engine core）
//
// 这个文件**不依赖 Electron**，被两边共用：
//   1. electron/main.cjs —— 桌面应用主进程（Cookie 取自 Electron session）
//   2. agent/tools.mjs   —— 本地 Agent 接口（Cookie 取自用户显式导出的文件）
// 站点判定、引擎调用、格式映射、下载参数、进度解析、落盘核对、设置/历史/登录态
// 存储只保留这一份实现，避免界面与接口两条路各说一套。
//
// 安全边界：Cookie 值只在本机进程间传递，永不进入返回值、日志或历史。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const path = require('node:path');

const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const CONTROL_OR_TAB = new RegExp('[' + String.fromCharCode(9) + String.fromCharCode(10) + String.fromCharCode(13) + ']', 'g');

// ── 站点定义 ──────────────────────────────────────────────────────────────
// sessionCookieNames 只记录"判定登录所需的 Cookie 名"，不记录值。
const LOGIN_SITES = {
  douyin: {
    id: 'douyin',
    label: '抖音',
    domains: ['douyin.com', 'iesdouyin.com'],
    title: '登录抖音',
    homeUrl: 'https://www.douyin.com/',
    partition: 'persist:qydouyin',
    sessionCookieNames: ['sessionid', 'sessionid_ss', 'sid_guard'],
    filePrefix: 'qingying-douyin-',
    exportName: 'qingying-douyin.cookies.txt',
    loginRequired: true,
    contentKind: 'video',
    loginPrompt: '抖音内容需要先登录，请先完成登录后再解析。',
    reloginPrompt: '抖音登录已失效，请重新登录。',
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    domains: ['tiktok.com'],
    title: '登录 TikTok',
    homeUrl: 'https://www.tiktok.com/',
    partition: 'persist:qytiktok',
    sessionCookieNames: ['sessionid', 'sessionid_ss', 'sid_guard'],
    filePrefix: 'qingying-tiktok-',
    exportName: 'qingying-tiktok.cookies.txt',
    loginRequired: false,
    contentKind: 'video',
    loginPrompt: 'TikTok 部分内容需要登录，建议先登录后再解析。',
    reloginPrompt: 'TikTok 登录已失效，请重新登录。',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  },
  bilibili: {
    id: 'bilibili',
    label: '哔哩哔哩',
    domains: ['bilibili.com', 'b23.tv'],
    title: '登录哔哩哔哩',
    homeUrl: 'https://www.bilibili.com/',
    partition: 'persist:qybilibili',
    sessionCookieNames: ['SESSDATA', 'DedeUserID'],
    filePrefix: 'qingying-bilibili-',
    exportName: 'qingying-bilibili.cookies.txt',
    loginRequired: false,
    contentKind: 'video',
    loginPrompt: '哔哩哔哩高码率与会员内容需要登录，建议先登录。',
    reloginPrompt: '哔哩哔哩登录已失效，请重新登录。',
    cookieHint: '哔哩哔哩风控较严，建议先登录并在弹出的窗口中打开过站点后再重试。',
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    label: '小红书',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    title: '登录小红书',
    homeUrl: 'https://www.xiaohongshu.com/',
    partition: 'persist:qyxhs',
    sessionCookieNames: ['web_session'],
    filePrefix: 'qingying-xhs-',
    exportName: 'qingying-xiaohongshu.cookies.txt',
    loginRequired: false,
    contentKind: 'images',
    loginPrompt: '小红书部分内容需要登录，建议先登录。',
    reloginPrompt: '小红书登录已失效，请重新登录。',
    cookieHint: '小红书笔记多为图片，登录后再解析成功率更高。',
  },
  instagram: {
    id: 'instagram',
    label: 'Instagram',
    domains: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
    title: '登录 Instagram',
    homeUrl: 'https://www.instagram.com/',
    partition: 'persist:qyinsta',
    sessionCookieNames: ['sessionid', 'ds_user_id'],
    filePrefix: 'qingying-instagram-',
    exportName: 'qingying-instagram.cookies.txt',
    loginRequired: false,
    contentKind: 'images',
    loginPrompt: 'Instagram 现在强制要求登录，请先登录。',
    reloginPrompt: 'Instagram 登录已失效，请重新登录。',
    cookieHint: 'Instagram 现在强制要求登录，请先登录后再重试。',
  },
};

const SITE_IDS = Object.keys(LOGIN_SITES);
const DEFAULT_FILENAME_TEMPLATE = '%(title).180B [%(id)s].%(ext)s';

// 界面用的站点表：从上面唯一一份定义派生（界面再抄一遍域名就会和这里分叉）。
function siteCatalog() {
  return SITE_IDS.map((siteId) => ({
    id: siteId,
    label: LOGIN_SITES[siteId].label,
    domains: LOGIN_SITES[siteId].domains,
    content_kind: LOGIN_SITES[siteId].contentKind,
    login_required: LOGIN_SITES[siteId].loginRequired,
    login_prompt: LOGIN_SITES[siteId].loginPrompt,
    engine_kind: LOGIN_SITES[siteId].contentKind === 'images' ? '图集为主' : '视频为主',
  }));
}

// 允许出现在命名模板里的 yt-dlp 字段（白名单，防止把用户输入拼成任意参数）。
const TEMPLATE_FIELDS = [
  'title', 'id', 'ext', 'uploader', 'channel', 'autonumber',
  'playlist', 'epoch', 'webpage_url', 'resolution', 'duration',
];
const TEMPLATE_FIELD_SET = new Set(TEMPLATE_FIELDS);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif']);

// ── URL / 文本工具 ────────────────────────────────────────────────────────
function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeMediaUrl(value) {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  const isDouyin = hostname === 'douyin.com' || hostname.endsWith('.douyin.com');
  const modalId = parsed.searchParams.get('modal_id');
  if (isDouyin && modalId && /^[0-9]{10,25}$/.test(modalId)) {
    return 'https://www.douyin.com/video/' + modalId;
  }
  return parsed.toString();
}

function isSiteUrl(value, site) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return site.domains.some((domain) => hostname === domain || hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

function matchLoginSite(value) {
  if (!isHttpUrl(value)) return null;
  for (const site of Object.values(LOGIN_SITES)) {
    if (isSiteUrl(value, site)) return site;
  }
  return null;
}

function safeText(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeExt(value) {
  const extension = safeText(value, 12).toLowerCase();
  return /^[a-z0-9]+$/.test(extension) ? extension : '';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return value.toFixed(unit === 0 || value >= 100 ? 0 : 1) + ' ' + units[unit];
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return formatBytes(bytes);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return '';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return (h > 0 ? [h, m, s] : [m, s]).map((v) => String(v).padStart(2, '0')).join(':');
}

// Windows 文件名保留字符 + 控制字符。按字符码逐个过滤，避免正则转义歧义。
function stripIllegalNameChars(value) {
  let out = '';
  for (const char of String(value)) {
    if (char.codePointAt(0) <= 31) continue;
    if ('<>:"/\\|?*'.includes(char)) continue;
    out += char;
  }
  return out;
}

function sanitizeFileName(value, max = 80) {
  const cleaned = stripIllegalNameChars(safeText(value, max * 2)).trim();
  return cleaned || 'image';
}

function uniquePath(dir, name, ext) {
  let candidate = path.join(dir, name + '.' + ext);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, name + ' (' + index + ').' + ext);
    index += 1;
  }
  return candidate;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── 命名模板：只允许白名单字段，不合法就拒绝而不是猜 ──────────────────────
function validateFilenameTemplate(value) {
  const template = safeText(value, 200).trim();
  if (!template) return { ok: false, error: '命名模板不能为空。' };
  if (new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']').test(template)) {
    return { ok: false, error: '命名模板不能包含换行或控制字符。' };
  }
  const tokens = template.match(/%\([^)]*\)/g) || [];
  if (template.indexOf('%') >= 0 && tokens.length === 0) {
    return { ok: false, error: '百分号只能用于 %(字段名) 形式的占位符。' };
  }
  const used = [];
  for (const token of tokens) {
    const body = token.slice(2, -1);
    const name = body.match(/^[A-Za-z_]+/);
    if (!name) {
      return { ok: false, error: '无法识别的占位符 ' + token + '。可用字段：' + TEMPLATE_FIELDS.join(', ') + '。' };
    }
    if (!TEMPLATE_FIELD_SET.has(name[0])) {
      return { ok: false, error: '占位符 ' + token + ' 的字段 ' + name[0] + ' 不在允许列表内。可用字段：' + TEMPLATE_FIELDS.join(', ') + '。' };
    }
    used.push(name[0]);
  }
  if (!used.includes('ext')) {
    return { ok: false, error: '命名模板必须包含 %(ext)s，否则保存的文件没有扩展名。' };
  }
  return { ok: true, template, fields: used };
}

// 用已解析到的元信息预览文件名（只算字符串，不落盘）。
function previewFilename(template, sample) {
  const data = sample || {};
  return safeText(template, 200).replace(/%\(([A-Za-z_]+)\)(\.?[0-9]*[A-Za-z_-]*)/g, (whole, field, modifiers) => {
    const raw = data[field];
    if (raw === undefined || raw === null || raw === '') return '<' + field + '>';
    let text = String(raw);
    const bytesLimit = /\.(\d+)B/.exec(modifiers || '');
    if (bytesLimit) {
      const limit = Number(bytesLimit[1]);
      if (Buffer.byteLength(text) > limit) text = safeUtf8Truncate(text, limit);
    }
    if (/U$/.test(modifiers || '')) text = text.toUpperCase();
    if (/l$/.test(modifiers || '')) text = text.toLowerCase();
    return stripIllegalNameChars(text);
  });
}

function safeUtf8Truncate(text, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += char;
  }
  return out;
}

// ── 引擎发现与探测 ────────────────────────────────────────────────────────
const ENGINE_ENV = {
  'yt-dlp': 'QINGYING_YT_DLP',
  'gallery-dl': 'QINGYING_GALLERY_DL',
  'ffmpeg': 'QINGYING_FFMPEG',
};

// 解析顺序：显式 override（打包内 resources/bin）→ 环境变量 → 已知安装目录 → PATH。
// source 字段如实说明这次用的是哪一条，界面与接口都显示它。
function resolveEnginePath(name, options) {
  const opts = options || {};
  const overrides = opts.overrides || {};
  const candidates = [];
  if (overrides[name]) candidates.push({ path: overrides[name], source: 'override' });
  const fromEnv = safeText(process.env[ENGINE_ENV[name]], 1024).trim();
  if (fromEnv) candidates.push({ path: fromEnv, source: 'env' });
  for (const root of opts.extraRoots || []) {
    if (!root) continue;
    candidates.push({ path: path.join(root, name + '.exe'), source: 'bundled' });
    candidates.push({ path: path.join(root, name), source: 'bundled' });
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate.path).isFile()) return candidate;
    } catch {}
  }
  if (lookUpOnPath(name)) return { path: name, source: 'PATH' };
  return null;
}

function lookUpOnPath(name) {
  const exts = process.platform === 'win32'
    ? (safeText(process.env.PATHEXT, 512) || '.EXE;.CMD;.BAT').split(';')
    : [''];
  const dirs = safeText(process.env.PATH, 16384).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(full).isFile()) return full;
      } catch {}
    }
  }
  return null;
}

class EngineError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    Object.assign(this, extra || {});
  }
}

function runTool(executable, args, options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 120000;
  const maxStdoutBytes = opts.maxStdoutBytes || 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: opts.env || process.env,
      });
    } catch (error) {
      reject(normalizeSpawnError(error, executable));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let finished = false;
    let timedOut = false;
    let outputTooLarge = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);

    const finish = (callback) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      callback();
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        outputTooLarge = true;
        terminateProcessTree(child);
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk.toString('utf8'));
    });
    child.once('error', (error) => finish(() => reject(normalizeSpawnError(error, executable))));
    child.once('close', (code) => finish(() => {
      if (timedOut) {
        reject(new EngineError('timeout', '连接超时，请检查网络后重试。'));
      } else if (outputTooLarge) {
        reject(new EngineError('too_large', '解析结果过大，已停止处理。'));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new EngineError('engine_failed', safeText(stderr.trim()) || ('工具退出，代码 ' + code), {
          stdout,
          stderr,
          exitCode: code,
        }));
      }
    }));
  });
}

function normalizeSpawnError(error, executable) {
  if (error && error.code === 'ENOENT') {
    return new EngineError('engine_missing', '找不到引擎可执行文件：' + executable, { cause: error.message });
  }
  return error;
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        try {
          child.kill();
        } catch {}
      });
      return;
    } catch {}
  }
  try {
    child.kill('SIGTERM');
  } catch {}
}

function appendTail(current, addition, maxLength) {
  const combined = current + addition;
  const limit = maxLength || 65536;
  return combined.length > limit ? combined.slice(-limit) : combined;
}

function createLineConsumer(onLine) {
  let remainder = '';
  return {
    push(chunk) {
      const lines = (remainder + chunk).split(/\r?\n/);
      remainder = lines.pop() || '';
      lines.filter(Boolean).forEach(onLine);
    },
    flush() {
      if (remainder) onLine(remainder);
      remainder = '';
    },
  };
}

// ffmpeg 只认 `-version`（`--version` 会以 8 退出），而且版本号在第一行整句 banner 里。
const VERSION_ARGS = {
  'yt-dlp': ['--version'],
  'gallery-dl': ['--version'],
  'ffmpeg': ['-version'],
};

function extractVersion(name, stdout) {
  const firstLine = safeText(stdout.split(/\r?\n/)[0], 200).trim();
  if (name === 'ffmpeg') {
    const match = /ffmpeg version (\S+)/.exec(firstLine);
    return match ? match[1] : firstLine.slice(0, 60);
  }
  return firstLine.slice(0, 40);
}

async function probeEngine(name, options) {
  const resolved = resolveEnginePath(name, options);
  if (!resolved) {
    return { name, available: false, version: '', path: '', source: 'not_found', error: '未安装，或不在搜索到的位置内' };
  }
  try {
    const { stdout } = await runTool(resolved.path, VERSION_ARGS[name] || ['--version'], {
      timeoutMs: (options && options.probeTimeoutMs) || 15000,
    });
    return { name, available: true, version: extractVersion(name, stdout), path: resolved.path, source: resolved.source, error: '' };
  } catch (error) {
    return {
      name,
      available: false,
      version: '',
      path: resolved.path,
      source: resolved.source,
      error: safeText(error.message, 200),
    };
  }
}

async function probeEngines(options) {
  const [ytdlp, galleryDl, ffmpeg] = await Promise.all([
    probeEngine('yt-dlp', options),
    probeEngine('gallery-dl', options),
    probeEngine('ffmpeg', options),
  ]);
  return { yt_dlp: ytdlp, gallery_dl: galleryDl, ffmpeg, checked_at: new Date().toISOString() };
}

// ── Cookie：Netscape 文件与登录态快照（永不输出值）────────────────────────
function isSiteCookie(cookie, site) {
  const cookieDomain = safeText(cookie && cookie.domain, 200).replace(/^\./, '').toLowerCase();
  return site.domains.some((domain) => cookieDomain === domain || cookieDomain.endsWith('.' + domain));
}

function buildNetscapeCookieFile(site, cookies) {
  const mine = (Array.isArray(cookies) ? cookies : []).filter((cookie) => isSiteCookie(cookie, site));
  if (!mine.length) return '';
  const lines = ['# Netscape HTTP Cookie File', '# qingying-downloader temporary cookie jar'];
  for (const cookie of mine) {
    const domain = cookie.domain || ('.' + site.domains[0]);
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = Math.max(0, Math.floor(cookie.expirationDate || 0));
    const name = safeText(cookie.name, 200).replace(CONTROL_OR_TAB, '');
    const value = safeText(cookie.value, 8192).replace(CONTROL_OR_TAB, '');
    lines.push([domain, includeSubdomains, cookie.path || '/', secure, expires, name, value].join(TAB));
  }
  return lines.join(LF) + LF;
}

async function writeTempCookieFile(site, cookies, tempDir) {
  const content = buildNetscapeCookieFile(site, cookies);
  if (!content) return '';
  ensureDirSync(tempDir);
  const cookiePath = path.join(tempDir, site.filePrefix + process.pid + '-' + Date.now() + '.txt');
  await fs.promises.writeFile(cookiePath, content, { encoding: 'utf8', mode: 0o600 });
  return cookiePath;
}

// 只删除本项目写出的 Cookie 文件，且必须位于给定目录内。
function removeCookieFile(cookiePath, allowedDirs) {
  if (!cookiePath) return false;
  const resolved = path.resolve(cookiePath);
  const roots = (Array.isArray(allowedDirs) ? allowedDirs : [allowedDirs]).filter(Boolean).map((d) => path.resolve(d));
  const prefixes = Object.values(LOGIN_SITES).map((site) => site.filePrefix);
  const inRoot = roots.some((root) => path.dirname(resolved) === root);
  const ours = prefixes.some((prefix) => path.basename(resolved).startsWith(prefix));
  if (!inRoot || !ours) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch {
    return false;
  }
}

function parseNetscapeCookieFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const cookies = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split(TAB);
    if (parts.length < 7) continue;
    cookies.push({
      domain: parts[0],
      includeSubdomains: parts[1] === 'TRUE',
      path: parts[2] || '/',
      secure: parts[3] === 'TRUE',
      expirationDate: Number(parts[4]) || 0,
      name: parts[5],
      value: parts.slice(6).join(TAB),
    });
  }
  return cookies.length ? cookies : null;
}

function cookieFileUsable(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

// 登录态快照：只有名称、数量与最早过期时间，绝不包含 Cookie 值。
function summarizeLoginCookies(site, cookies) {
  const mine = (Array.isArray(cookies) ? cookies : []).filter((c) => isSiteCookie(c, site));
  const nowSec = Date.now() / 1000;
  const living = mine.filter((c) => !c.expirationDate || c.expirationDate > nowSec);
  const matched = site.sessionCookieNames
    .map((name) => living.find((c) => c.name === name))
    .filter(Boolean);
  const aliveExpiries = mine.filter((c) => c.expirationDate && c.expirationDate > nowSec).map((c) => c.expirationDate).sort((a, b) => a - b);
  const expiredOnly = mine.some((c) => c.expirationDate && c.expirationDate <= nowSec) && !matched.length;
  return {
    loggedIn: matched.length > 0,
    matchedCookieNames: matched.map((c) => c.name),
    cookieCount: mine.length,
    expiredDetected: expiredOnly,
    earliestExpiry: aliveExpiries.length ? new Date(aliveExpiries[0] * 1000).toISOString() : '',
  };
}

// ── 取图（无 Electron 依赖；Electron 侧可传自己的 fetch 实现）──────────────
function fetchBuffer(url, headers, redirectCount, maxBytes) {
  const redirs = redirectCount || 0;
  const limit = maxBytes || 100 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    if (redirs > 5) {
      reject(new Error('重定向次数过多'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('地址无效'));
      return;
    }
    const lib = parsed.protocol === 'https:' ? https : http;
    const request = lib.get(parsed, { headers: headers || {} }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        fetchBuffer(new URL(response.headers.location, parsed).toString(), headers, redirs + 1, limit).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error('HTTP ' + status));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > limit) {
          request.destroy(new Error('内容过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.setTimeout(30000, () => request.destroy(new Error('连接超时')));
    request.on('error', reject);
  });
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

async function fetchThumbnailDataUrl(url, referer, fetchImpl) {
  if (!isHttpUrl(url)) return '';
  const doFetch = fetchImpl || (async (target) => {
    const buffer = await fetchBuffer(target, { 'User-Agent': 'Mozilla/5.0', Referer: referer }, 0, 8 * 1024 * 1024);
    return { ok: true, headers: { get: () => '' }, arrayBuffer: async () => buffer };
  });
  try {
    const response = await doFetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', ...(isHttpUrl(referer) ? { Referer: referer } : {}) },
    });
    if (!response || response.ok === false) return '';
    const getter = response.headers && typeof response.headers.get === 'function' ? response.headers : null;
    const contentType = safeText(getter ? getter.get('content-type') : '', 120);
    if (contentType && !contentType.toLowerCase().startsWith('image/')) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return '';
    return 'data:' + (contentType.split(';')[0] || 'image/jpeg') + ';base64,' + bytes.toString('base64');
  } catch {
    return '';
  }
}

// ── 格式映射（yt-dlp --dump-single-json）──────────────────────────────────
function mapFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videoExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi', 'ts', '3gp']);
  const audioExtensions = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);
  const unknownCodecs = (f) => !f.vcodec && !f.acodec;

  const rawVideos = formats
    .filter((f) => (f.vcodec && f.vcodec !== 'none') || (unknownCodecs(f) && videoExtensions.has(String(f.ext).toLowerCase())))
    .map((f) => {
      const unknownSource = unknownCodecs(f);
      return {
        id: String(f.format_id),
        ext: f.ext || '',
        resolution: f.resolution || (f.height ? (f.width || '?') + 'x' + f.height : '源文件'),
        height: Number(f.height) || 0,
        fps: Number(f.fps) || 0,
        codec: f.vcodec || '源编码',
        hasAudio: unknownSource || Boolean(f.acodec && f.acodec !== 'none'),
        size: formatSize(Number(f.filesize || f.filesize_approx)),
        note: f.format_note || '',
        score: (f.acodec === 'none' ? 100000 : 0)
          + (f.ext === 'mp4' ? 10000 : 0)
          + (Number(f.fps) || 0) * 100
          + (Number(f.tbr) || 0),
      };
    });

  const bestByHeight = new Map();
  for (const item of rawVideos) {
    const key = item.height || item.resolution || 'unknown';
    const current = bestByHeight.get(key);
    if (!current || item.score > current.score) bestByHeight.set(key, item);
  }
  const videos = [...bestByHeight.values()]
    .sort((a, b) => b.height - a.height || b.score - a.score)
    .slice(0, 10)
    .map(({ score, ...item }) => item);

  const rawAudios = formats
    .filter((f) => ((!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none')
      || (unknownCodecs(f) && audioExtensions.has(String(f.ext).toLowerCase())))
    .map((f) => ({
      id: String(f.format_id),
      ext: f.ext || '',
      codec: f.acodec || '',
      abr: Number(f.abr) || 0,
      size: formatSize(Number(f.filesize || f.filesize_approx)),
      language: f.language || '',
      note: f.format_note || '',
    }))
    .sort((a, b) => b.abr - a.abr);

  const seen = new Set();
  const audios = rawAudios.filter((item) => {
    const band = item.abr ? Math.round(item.abr / 16) * 16 : 0;
    const key = [item.ext, item.codec, band, item.language].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  return { videos, audios };
}

function parseGalleryDlJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const items = [];
  let pending = null;
  for (const entry of parsed) {
    if (!Array.isArray(entry) || !entry.length) continue;
    const [code, payload] = entry;
    if (code === 2 && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      if (typeof payload.url === 'string' && isHttpUrl(payload.url)) {
        items.push({ url: payload.url, ext: payload.extension, meta: payload });
        pending = null;
      } else {
        pending = payload;
      }
    } else if (code === 3 && typeof payload === 'string' && isHttpUrl(payload)) {
      const meta = pending || {};
      const ext = meta.extension || (payload.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i) || [])[1] || '';
      items.push({ url: payload, ext, meta });
      pending = null;
    }
  }
  return items
    .map(({ url, ext, meta }) => ({
      url,
      ext: safeExt(ext) || 'jpg',
      filename: safeText(meta.filename || '', 100),
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      postIndex: Number(meta.post_index) || 0,
    }))
    .filter((item) => IMAGE_EXTENSIONS.has(item.ext));
}

// ── 引擎判定：一个链接进来，谁先上、为什么、失败后换谁 ─────────────────────
// 返回的 chain 是**完整判定过程**（含本机不可用的那一步，标 unavailable），
// executable 才是真会跑的序列。界面把 chain 原样摊开，用户看得见"为什么用它、
// 备胎为什么没上"，降级永远不会是静默的。
function planEngine(url, engines, preference) {
  const site = matchLoginSite(url);
  // 探测结果用的键是 yt_dlp / gallery_dl（下划线），决策里说的是 yt-dlp / gallery-dl（连字符）。
  // 这里必须换算，否则"备胎在不在本机"永远被判成不在 —— 界面会说假话。
  const keyOf = (name) => (name === 'yt-dlp' ? 'yt_dlp' : name === 'gallery-dl' ? 'gallery_dl' : name);
  const has = (name) => Boolean(engines && engines[keyOf(name)] && engines[keyOf(name)].available);
  const imageSite = Boolean(site && site.contentKind === 'images');

  // yt-dlp 先上：它能给出作者/标题/画质；图集链接在它手里会"没有音视频格式"，
  // 那正是降级 gallery-dl 的信号。
  const ordered = imageSite
    ? [
      { engine: 'yt-dlp', why: (site.label + ' 的链接先按视频解析，能拿到作者与标题等元信息') },
      { engine: 'gallery-dl', why: 'yt-dlp 没有给出音视频格式时，说明这条链接是图集，自动降级 gallery-dl' },
    ]
    : [
      {
        engine: 'yt-dlp',
        why: site ? site.label + ' 属于视频站点，用 yt-dlp 取画质与音轨' : '通用链接按视频解析，用 yt-dlp 取画质与音轨',
      },
      { engine: 'gallery-dl', why: 'yt-dlp 判定这条链接其实是图片时，自动降级 gallery-dl' },
    ];

  const wanted = preference === 'yt-dlp' || preference === 'gallery-dl' ? preference : '';
  let chain = ordered.map((step, index) => ({
    engine: step.engine,
    role: index === 0 ? 'primary' : 'fallback',
    reason: step.why,
    available: has(step.engine),
  }));

  if (wanted) {
    const chosen = chain.filter((step) => step.engine === wanted).concat(chain.filter((step) => step.engine !== wanted));
    const label = wanted === 'gallery-dl' ? '图片链路' : '视频链路';
    chosen.forEach((step, index) => {
      step.reason = index === 0
        ? '设置里指定了 ' + wanted + '（' + label + '优先）'
        : '指定引擎没有可用结果时自动改用另一个引擎';
    });
    chain = chosen;
  }
  chain.forEach((step, index) => { step.role = index === 0 ? 'primary' : 'fallback'; });

  for (const step of chain) {
    if (!step.available) {
      step.unavailable = true;
      step.reason += '；但本机没有可用的 ' + step.engine + '，这一步跑不了';
    }
  }

  const executable = chain.filter((step) => step.available);
  // 偏好引擎在本机根本不可用时，实际执行的引擎必须说清理由，不能沿用"设置里指定了 X"。
  if (wanted && !has(wanted) && executable.length) {
    executable[0].reason = '设置里指定的 ' + wanted + ' 在本机不可用，这次实际改用 ' + executable[0].engine;
  }

  return {
    chain,
    executable,
    primary: executable.length ? executable[0].engine : '',
    site,
    preference: wanted || 'auto',
  };
}

// ── 解析：yt-dlp 主链路 ───────────────────────────────────────────────────
async function analyzeWithYtDlp(spec) {
  const { url, executable, cookieFile, timeoutMs } = spec;
  const args = ['--dump-single-json', '--no-warnings', '--no-colors', '--no-playlist', '--skip-download'];
  const site = matchLoginSite(url);
  if (site && site.userAgent) args.push('--user-agent', site.userAgent);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(url);

  const { stdout } = await runTool(executable, args, { timeoutMs: timeoutMs || 120000 });
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    throw new EngineError('bad_output', 'yt-dlp 输出不是合法 JSON，无法读取格式列表。');
  }
  const { videos, audios } = mapFormats(info);
  const playlist = Array.isArray(info.entries) ? info.entries.length : 0;
  return {
    engine: 'yt-dlp',
    data: {
      title: safeText(info.title || '未命名内容', 300),
      uploader: safeText(info.uploader || info.channel || info.uploader_id || '', 200),
      duration: Number(info.duration) || 0,
      webpageUrl: url,
      webpageBasename: info.webpage_basename || (site ? site.label : ''),
      sessionId: site ? site.id : '',
      siteLabel: site ? site.label : new URL(url).hostname,
      thumbnailUrl: safeText(info.thumbnail || '', 1024),
      playlistCount: playlist,
      videos,
      audios,
      images: [],
    },
  };
}

async function analyzeWithGalleryDl(spec) {
  const { url, executable, cookieFile, timeoutMs } = spec;
  const args = ['-j', '--no-colors'];
  const site = matchLoginSite(url);
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(url);

  const { stdout } = await runTool(executable, args, { timeoutMs: timeoutMs || 90000 });
  const images = parseGalleryDlJson(stdout).slice(0, 300);
  if (!images.length) return null;
  const first = images[0].meta || {};
  return {
    engine: 'gallery-dl',
    data: {
      title: safeText(first.title || images[0].filename || '图片作品', 300),
      uploader: safeText(first.author || first.uploader || '', 200),
      duration: 0,
      webpageUrl: url,
      webpageBasename: first.category || (site ? site.label : ''),
      sessionId: site ? site.id : '',
      siteLabel: site ? site.label : new URL(url).hostname,
      thumbnailUrl: '',
      playlistCount: 0,
      videos: [],
      audios: [],
      images,
    },
  };
}

// ── 失败归因：把引擎的原始抱怨翻译成"下一步能点什么" ───────────────────────
// 六条出路必须分得开，因为它们下一步完全不同：
//   链接不支持(unsupported_url) / 链接已失效(link_gone) / 需要登录(login_required)
//   站点改版(site_changed) / 网络或代理(network|proxy) / 引擎未装(engine_missing)
const LOGIN_PATTERNS = /\b(login|log-in|sign in|signin|cookies?|authentication|unauthorized|forbidden|vip|premium|private|access denied|restricted)\b/i;
const NETWORK_PATTERNS = /\b(timed out|timeout|connection|network|unreachable|resolve|econnrefused|getaddrinfo|retrying)\b/i;
const PROXY_PATTERNS = /\b(proxy|proxies|407|tunnel)\b|certificate|x509|self[- ]signed|ssl (?:error|handshake|certificate)|tls (?:error|handshake)|unable to get local issuer/i;
const RATE_PATTERNS = /\b(too many|429|rate limit|slow down|blocked|flood)\b/i;
const SITE_CHANGED_PATTERNS = /please report this issue|unable to extract|could not find .* (?:in|on) |extractor (?:error|failed)|unsupported url.*extractor/i;
const LINK_GONE_PATTERNS = /http error 40[49]|http error 410|\bnot found\b|video unavailable|private video|内容已被删除|链接已失效/i;
const LOGIN_HINTS_CN = ['登录', '风控', '验证', '权限', '会员'];
const NETWORK_HINTS_CN = ['超时', '连接', '网络', '代理'];

function classifyParseError(message, site, engineName) {
  const text = safeText(message, 1200);
  const lowered = text.toLowerCase();
  const remedies = [];
  let kind = 'unknown';

  if (/engine_missing|找不到引擎/.test(lowered) || /was not found|is not recognized/.test(lowered)) {
    kind = 'engine_missing';
    remedies.push({ action: 'install_engine', label: '检查引擎', detail: '本机没有可用的 ' + (engineName || '引擎') + '，安装或在"引擎目录"里指到 yt-dlp / gallery-dl / ffmpeg 所在文件夹后点"重新探测"。' });
  } else if (PROXY_PATTERNS.test(lowered)) {
    kind = 'proxy';
    remedies.push({ action: 'check_network', label: '检查代理设置', detail: '这一步被代理或 TLS 拦下了（代理拒绝、407、证书或隧道错误）。本机需要代理时，请先设好 HTTPS_PROXY / 系统代理，或换一条能直连的网络再重试。' });
    remedies.push({ action: 'retry', label: '改好代理后重试' });
  } else if (RATE_PATTERNS.test(lowered) || lowered.includes('限流')) {
    kind = 'rate_limited';
    remedies.push({ action: 'wait_retry', label: '稍后重试', detail: '站点在限流，一般等 1-3 分钟再解析同一链接；期间不要连续重试，那只会延长被限流的时间。' });
  } else if (LOGIN_PATTERNS.test(lowered) || LOGIN_HINTS_CN.some((hint) => text.includes(hint))) {
    kind = site ? 'login_required' : 'needs_login';
    const blocked = /http error 40[13]|forbidden|bot confirm|cloudflare/i.test(lowered);
    if (site) {
      remedies.push({ action: 'login', label: '登录 ' + site.label, detail: site.loginPrompt });
      remedies.push({ action: 'open_site', label: '在浏览器打开这条链接', detail: '先确认自己在浏览器里能正常看到内容（打不开说明链接失效或需要权限）。' });
    } else {
      remedies.push({ action: 'open_site', label: '在浏览器打开这条链接', detail: '确认内容是否公开可见；这个站点没有登录会话可用，只能匿名解析。' });
    }
    if (blocked) {
      remedies.push({ action: 'retry', label: '换个网络或代理后重试', detail: '站点直接拒绝了这条数据的下载（403/401）：可能是需要登录、当前 IP 或代理被风控、也可能是解析出的直链已过期。页面能解析不代表能取流。' });
    }
  } else if (LINK_GONE_PATTERNS.test(lowered)) {
    kind = 'link_gone';
    remedies.push({ action: 'open_site', label: '在浏览器打开这条链接', detail: '内容大概率已被删除、设为私密或原作者撤回 —— 这类链接换引擎也没用。' });
    remedies.push({ action: 'copy_link', label: '回到输入框换一条链接', detail: '从站点页面重新分享一次链接（分享链常带签名，过期后就取不到了）。' });
  } else if (NETWORK_PATTERNS.test(lowered) || NETWORK_HINTS_CN.some((hint) => text.includes(hint))) {
    kind = 'network';
    remedies.push({ action: 'check_network', label: '检查网络/代理', detail: '解析需要能访问该站点；本机走代理时请在系统设置或 HTTPS_PROXY 环境变量里指好，改好后重试。' });
    remedies.push({ action: 'retry', label: '重试解析' });
  } else if (SITE_CHANGED_PATTERNS.test(text)) {
    kind = site ? 'site_changed' : 'unsupported_site';
    remedies.push({ action: 'update_engine', label: '更新引擎后重新探测', detail: '引擎自己说"请把这个 issue 报告上去"，或某个字段抽不出来了 —— 这通常是站点改版而本机 yt-dlp / gallery-dl 版本落后，升级引擎常能直接解决。' });
    if (site) {
      remedies.push({ action: 'other_engine', label: '改用另一个引擎重试', detail: site.label + ' 改版时，另一条链路有时还读得到。' });
    }
    remedies.push({ action: 'retry', label: '稍后重试', detail: '站点改版期间，服务端返回可能还不稳定。' });
  } else if (/no formats|unsupported|not supported|unable to (?:find|download)/i.test(text)) {
    kind = 'unsupported_url';
    remedies.push({ action: 'check_page_type', label: '确认这是具体内容页', detail: '首页、搜索结果页、用户主页这类"不是单条内容"的地址，引擎没有可下载的东西；请打开一条视频/笔记后再复制链接。' });
    remedies.push({ action: 'other_engine', label: '改用另一个引擎重试', detail: '视频与图集走的是不同引擎，换一次常能出结果。' });
    remedies.push({ action: 'open_site', label: '在浏览器打开这条链接', detail: '确认链接没有指向登录墙或跳转中间页。' });
  } else {
    kind = 'unknown';
    remedies.push({ action: 'retry', label: '重试解析' });
    remedies.push({ action: 'other_engine', label: '改用另一个引擎重试' });
  }
  remedies.push({ action: 'copy_diagnostics', label: '复制诊断信息', detail: '把引擎原始输出带给开发者或 issue。' });
  return { kind, message: text, remedies };
}

// 一次解析的完整编排：引擎链 + Cookie 提供者 + 失败归因。
// cookieProvider(site) -> Promise<cookieFilePath | ''>（由调用方决定 Cookie 从哪来）
async function analyzeUrl(spec) {
  const raw = safeText(spec.url, 4096).trim();
  if (!isHttpUrl(raw)) {
    return { ok: false, error: '请输入有效的 http/https 网址。', kind: 'bad_url', remedies: [{ action: 'fix_url', label: '检查链接', detail: '只接受 http/https 开头的完整网址。' }] };
  }
  const url = normalizeMediaUrl(raw);
  const site = matchLoginSite(url);
  const engines = spec.engines || {};
  const plan = planEngine(url, engines, spec.preference);
  const attempts = [];
  const chain = plan.executable;
  const planText = plan.chain.map((step) => step.engine + '：' + step.reason).join('；');

  if (!chain.length) {
    return {
      ok: false,
      error: '本机没有可用的下载引擎（yt-dlp 与 gallery-dl 都没找到或版本探测失败）。',
      kind: 'engine_missing',
      engine: '',
      engine_reason: planText,
      engine_plan: plan.chain,
      remedies: [{ action: 'install_engine', label: '检查引擎', detail: '安装 yt-dlp（视频）与 gallery-dl（图片），或在"本机引擎"面板把"引擎目录"指到它们所在的文件夹，然后点"重新探测"。' }],
      engine_attempts: attempts,
    };
  }

  let cookieFile = '';
  let cookieFrom = '';
  if (site && typeof spec.cookieProvider === 'function') {
    try {
      cookieFile = await spec.cookieProvider(site);
      cookieFrom = cookieFile ? 'session' : 'none';
    } catch {
      cookieFile = '';
    }
  }
  if (site && site.loginRequired && !cookieFile) {
    return {
      ok: false,
      error: site.loginPrompt,
      kind: 'login_required',
      engine: '',
      engine_reason: planText,
      engine_plan: plan.chain,
      remedies: [
        { action: 'login', label: '登录 ' + site.label, detail: '登录窗口关闭后会自动重新检测登录态。' },
        { action: 'retry', label: '登录后重试' },
      ],
      engine_attempts: attempts,
    };
  }

  for (const step of chain) {
    const startedAt = Date.now();
    const record = engines[step.engine === 'yt-dlp' ? 'yt_dlp' : 'gallery_dl'];
    const executable = record && record.path
      ? record.path
      : (step.engine === 'yt-dlp' ? 'yt-dlp' : 'gallery-dl');
    try {
      const result = step.engine === 'yt-dlp'
        ? await analyzeWithYtDlp({ url, executable, cookieFile, timeoutMs: spec.timeoutMs })
        : await analyzeWithGalleryDl({ url, executable, cookieFile, timeoutMs: spec.timeoutMs });

      if (!result) {
        attempts.push({ engine: step.engine, outcome: 'no_result', ms: Date.now() - startedAt, detail: step.reason });
        continue;
      }
      const empty = !result.data.videos.length && !result.data.audios.length && !result.data.images.length;
      if (empty) {
        attempts.push({ engine: step.engine, outcome: 'no_formats', ms: Date.now() - startedAt, detail: step.reason });
        continue;
      }
      const usedChain = attempts.concat([{ engine: result.engine, outcome: 'ok', ms: Date.now() - startedAt, detail: step.reason }]);
      const imageOnly = !result.data.videos.length && !result.data.audios.length && result.data.images.length > 0;
      result.data.engine = result.engine;
      result.data.engine_version = record && record.version ? record.version : '';
      result.data.engine_source = record && record.source ? record.source : '';
      result.data.engine_reason = describeEngineChoice(result.engine, step.reason, usedChain, imageOnly, Boolean(cookieFile));
      result.data.engine_chain = usedChain;
      result.data.engine_plan = plan.chain;
      result.data.cookie_source = cookieFrom;
      if (spec.fetchThumbnail && result.data.thumbnailUrl) {
        result.data.thumbnail = await fetchThumbnailDataUrl(result.data.thumbnailUrl, url, spec.fetchThumbnail);
      } else {
        result.data.thumbnail = '';
      }
      return { ok: true, data: result.data, engine_attempts: usedChain };
    } catch (error) {
      attempts.push({
        engine: step.engine,
        outcome: 'failed',
        ms: Date.now() - startedAt,
        detail: safeText(error.message, 300),
      });
      // 图片链路失败或只有它一条时，直接给归因；否则继续尝试下一个引擎。
      const isLast = chain.indexOf(step) === chain.length - 1;
      if (!isLast) continue;
      const diagnosis = classifyParseError(error.message, site, step.engine);
      if (site && site.cookieHint && !cookieFile) {
        diagnosis.remedies.unshift({ action: 'login', label: '登录 ' + site.label, detail: site.cookieHint });
      }
      return {
        ok: false,
        error: diagnosis.message || '解析失败，请稍后重试。',
        kind: diagnosis.kind,
        remedies: diagnosis.remedies,
        engine: '',
        engine_reason: attempts.map((a) => a.engine + ' ' + a.outcome).join(' -> '),
        engine_plan: plan.chain,
        engine_attempts: attempts,
      };
    }
  }

  const diagnosis = classifyParseError('两个引擎都没有返回可用格式。', site, '');
  return {
    ok: false,
    error: 'yt-dlp 与 gallery-dl 都没有从这个链接取到可下载内容。',
    kind: 'no_formats',
    remedies: diagnosis.remedies,
    engine: '',
    engine_reason: attempts.map((a) => a.engine + ' ' + a.outcome).join(' -> '),
    engine_plan: plan.chain,
    engine_attempts: attempts,
  };
}

function describeEngineChoice(engine, reason, chain, imageOnly, hasCookie) {
  const triedOthers = chain.filter((a) => a.engine !== engine && a.outcome !== 'ok').map((a) => a.engine + '(' + a.outcome + ')');
  const parts = [engine === 'yt-dlp' ? 'yt-dlp（视频/音频链路）' : 'gallery-dl（图片链路）', reason];
  if (triedOthers.length) parts.push('先试过 ' + triedOthers.join('、') + '，没有可用结果');
  if (imageOnly) parts.push('这条链接只有图片，没有音视频格式');
  parts.push(hasCookie ? '已带上本机登录会话' : '未登录（匿名解析）');
  return parts.filter(Boolean).join('；');
}

// ── 下载参数与执行 ────────────────────────────────────────────────────────
const AUDIO_FORMATS = ['mp3', 'm4a', 'opus', 'wav'];
const DOWNLOAD_MODES = ['combined', 'video', 'audio', 'images'];

function buildDownloadArgs(spec) {
  const mode = spec.mode;
  const templateCheck = validateFilenameTemplate(spec.filenameTemplate || DEFAULT_FILENAME_TEMPLATE);
  const template = templateCheck.ok ? templateCheck.template : DEFAULT_FILENAME_TEMPLATE;
  const outputTemplate = spec.subfolderByPost && mode === 'images'
    ? path.join(String(spec.folderTemplate || '%(id)s'), template)
    : template;

  const args = [
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--no-colors',
    '--windows-filenames',
    '--continue',
    '--retries', String(clampInt(spec.retries, 0, 30, 20)),
    '--fragment-retries', String(clampInt(spec.retries, 0, 30, 20)),
    '--retry-sleep', '2',
    '--socket-timeout', '30',
    '--concurrent-fragments', String(clampInt(spec.concurrentFragments, 1, 8, 3)),
    '--ffmpeg-location', spec.ffmpegLocation || 'ffmpeg',
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(spec.outputDir, outputTemplate),
  ];
  if (spec.site && spec.site.userAgent) args.push('--user-agent', spec.site.userAgent);
  if (spec.cookieFile) args.push('--cookies', spec.cookieFile);

  if (mode === 'combined') {
    if (spec.videoHasAudio) {
      args.push('-f', spec.videoId);
    } else {
      const mp4Compatible = spec.videoExt === 'mp4' && ['m4a', 'mp4', 'aac'].includes(spec.audioExt);
      args.push('-f', spec.videoId + '+' + spec.audioId, '--merge-output-format', mp4Compatible ? 'mp4' : 'mkv');
    }
  } else if (mode === 'video') {
    args.push('-f', spec.videoId);
  } else {
    args.push('-f', spec.audioId, '-x', '--audio-format', AUDIO_FORMATS.includes(spec.audioFormat) ? spec.audioFormat : 'mp3');
  }
  args.push(spec.url);
  return args;
}

function clampInt(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

// 递归列出目录里的文件（含模板生成的子目录），用于核对真实落盘结果。
function listFiles(dir, options = {}) {
  const maxDepth = options.maxDepth === undefined ? 3 : options.maxDepth;
  const since = options.sinceMs || 0;
  const out = [];
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.part') || entry.name.endsWith('.ytdl')) continue;
        try {
          const stat = fs.statSync(full);
          if (since && stat.mtimeMs < since - 5000) continue;
          out.push({ path: full, bytes: stat.size, mtimeMs: stat.mtimeMs });
        } catch {}
      }
    }
  };
  walk(dir, 0);
  return out;
}

function diffFiles(before, after) {
  const seen = new Set(before.map((f) => f.path));
  return after.filter((f) => !seen.has(f.path));
}

// ── 未完成的分片（.part / .ytdl / .temp）───────────────────────────────────
// 暂停与取消都**保留**分片，配合 --continue 是续传而不是从头再来；崩溃后留下的
// 孤儿分片没人认领，所以给一个只按扩展名判定的清点/清理入口（只碰给定目录，
// 只删引擎临时后缀，绝不碰成品文件）。
const TEMP_SUFFIXES = ['.part', '.ytdl', '.temp'];

function isEngineTempFile(name) {
  const lower = String(name).toLowerCase();
  return TEMP_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function scanEngineTempFiles(dir, options = {}) {
  const maxDepth = options.maxDepth === undefined ? 3 : options.maxDepth;
  const absolute = safeText(dir, 1024).trim();
  if (!absolute || !path.isAbsolute(absolute)) return { dir: absolute, valid: false, files: [], count: 0, bytes: 0, oldest: '' };
  let stat;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { dir: absolute, valid: false, exists: false, files: [], count: 0, bytes: 0, oldest: '' };
  }
  if (!stat.isDirectory()) return { dir: absolute, valid: false, files: [], count: 0, bytes: 0, oldest: '' };
  const found = [];
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && isEngineTempFile(entry.name)) {
        try {
          const fileStat = fs.statSync(full);
          found.push({ path: full, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs });
        } catch {}
      }
    }
  };
  walk(absolute, 0);
  found.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return {
    dir: absolute,
    valid: true,
    files: found,
    count: found.length,
    bytes: found.reduce((sum, file) => sum + file.bytes, 0),
    oldest: found.length ? new Date(found[0].mtimeMs).toISOString() : '',
  };
}

// 只删给定目录内、后缀确实是引擎临时文件的条目；其余一律不动。
function removeEngineTempFiles(dir, options = {}) {
  const scan = options.scan || scanEngineTempFiles(dir, options);
  const removed = [];
  const failed = [];
  if (!scan.valid) return { removed, failed, count: 0, bytes: 0, error: '下载目录不可用，没有删除任何文件。' };
  const root = path.resolve(scan.dir);
  for (const file of scan.files) {
    const resolved = path.resolve(file.path);
    const inside = path.dirname(resolved) === root || path.dirname(resolved).startsWith(root + path.sep);
    if (!inside || !isEngineTempFile(path.basename(resolved))) {
      failed.push({ path: file.path, reason: '不在给定目录内或不是引擎临时文件' });
      continue;
    }
    try {
      fs.unlinkSync(resolved);
      removed.push(file);
    } catch (error) {
      failed.push({ path: file.path, reason: safeText(error.message, 120) });
    }
  }
  return {
    removed,
    failed,
    count: removed.length,
    bytes: removed.reduce((sum, file) => sum + file.bytes, 0),
  };
}

// 设置里的"引擎目录"是不是还在（用户搬过安装包就会留下指向旧位置的死路径）。
function enginesDirStatus(dir) {
  const value = safeText(dir, 1024).trim();
  if (!value) return { configured: false, path: '', exists: false, engines: [], note: '没有设置引擎目录，按环境变量、应用内 resources/bin 与 PATH 依次查找。' };
  let exists = false;
  try {
    exists = fs.statSync(value).isDirectory();
  } catch {}
  const present = ['yt-dlp', 'gallery-dl', 'ffmpeg'].filter((name) => {
    try {
      return fs.existsSync(path.join(value, name + '.exe')) || fs.existsSync(path.join(value, name));
    } catch {
      return false;
    }
  });
  return {
    configured: true,
    path: value,
    exists,
    engines: present,
    note: exists
      ? (present.length ? '目录里有 ' + present.join(' / ') + '。' : '目录存在，但里面没有 yt-dlp / gallery-dl / ffmpeg。')
      : '目录不存在（可能被移动或改名过）—— 本机的 ' + (present.length ? '' : 'gallery-dl / ffmpeg ') + '因此报未安装，请重新指一次。',
  };
}

// yt-dlp 报"这个文件落到哪里了"的行式样（真实输出形状）：落盘核对要把这些路径收下来，
// 否则同名文件早就存在时 mtime 不新，一次成功的下载会被报成 0 字节。
const DESTINATION_PATTERNS = [
  /^\[download\] Destination: (.+)$/,
  /^\[download\] (.+?) has already been downloaded$/,
  /^\[(?:ExtractAudio|VideoConvertor|FixupM4a|FixupStereo|FixupWebmExtension|MergeVCodecs)\] Destination: (.+)$/,
  /^\[Merger\] Merging formats into "(.+)"$/,
  /^\[download\] File was renamed to: (.+)$/,
];

function extractDestination(line) {
  for (const pattern of DESTINATION_PATTERNS) {
    const match = pattern.exec(line);
    if (match) return safeText(match[1], 1024).replace(/^"|"$/g, '').trim();
  }
  return '';
}

// 解析单行引擎输出：百分比/速度/剩余时间都来自 --progress-template 的真实字段。
function parseEngineLine(line) {
  const text = safeText(line, 2000);
  if (text.startsWith('download:')) {
    const [percent, speed, eta] = text.slice(9).split('|');
    return { type: 'progress', percent: safeText(percent, 20).trim(), speed: safeText(speed, 30).trim(), eta: safeText(eta, 30).trim() };
  }
  const destination = extractDestination(text);
  if (destination) return { type: 'destination', path: destination };
  return { type: 'log', text };
}

// 跑一次 yt-dlp 下载：进度回调 + 落盘核对（真实路径与字节数）。
function runEngineDownload(spec, hooks) {
  const h = hooks || {};
  const opts = spec.engineOptions || {};
  const resolved = resolveEnginePath('yt-dlp', opts);
  if (!resolved) {
    return Promise.resolve({ ok: false, error: '本机找不到 yt-dlp，无法下载。', code: 'engine_missing', files: [], bytes: 0 });
  }
  const args = buildDownloadArgs(spec);
  const before = listFiles(spec.outputDir, { maxDepth: 3 });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolved.path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: safeText(error.message, 600), code: 'spawn_failed', files: [], bytes: 0 });
      return;
    }
    const state = { cancelled: false, paused: false, child, args, cookieFile: spec.cookieFile };
    if (typeof h.onChild === 'function') h.onChild(state);

    let errorText = '';
    let settled = false;
    const destinations = new Set();

    // 引擎多吐一行没见过的东西，绝不能把整个进程带走（这里是主进程/接口服务本体）。
    const handleLine = (line) => {
      let parsed;
      try {
        parsed = parseEngineLine(line);
      } catch (error) {
        parsed = { type: 'log', text: safeText(line, 500) };
        if (typeof h.onLog === 'function') h.onLog('[line parse failed] ' + safeText(error && error.message, 120));
        return;
      }
      if (parsed.type === 'progress') {
        if (typeof h.onProgress === 'function') h.onProgress(parsed);
        return;
      }
      if (parsed.type === 'destination') destinations.add(parsed.path);
      if (typeof h.onLog === 'function') h.onLog(safeText(parsed.text, 500));
    };

    const stdoutLines = createLineConsumer((line) => handleLine(line));
    const stderrLines = createLineConsumer((line) => handleLine(line));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      stdoutLines.flush();
      stderrLines.flush();
      resolve(result);
    };

    child.stdout.on('data', (chunk) => stdoutLines.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      errorText = appendTail(errorText, text);
      stderrLines.push(text);
    });

    const settleFiles = () => {
      const after = listFiles(spec.outputDir, { maxDepth: 3 });
      const fresh = diffFiles(before, after);
      const freshPaths = new Set(fresh.map((f) => f.path));
      const byPath = new Map(after.map((f) => [f.path, f]));
      const merged = new Map();
      for (const file of fresh) merged.set(file.path, file);
      // 引擎在日志里报过目标路径的文件也算数 —— 本地早就下过同名文件时 mtime 不新，
      // 只按"新增"统计会把一次成功的下载报成 0 字节。
      for (const dest of destinations) {
        const absolute = path.isAbsolute(dest) ? dest : path.resolve(spec.outputDir, dest);
        let hit = byPath.get(absolute);
        if (!hit) {
          const base = path.basename(absolute);
          hit = after.find((file) => path.basename(file.path) === base);
        }
        if (hit) merged.set(hit.path, hit);
      }
      const files = [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
      const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
      return { files, bytes, already_present: files.filter((file) => !freshPaths.has(file.path)).length };
    };

    child.once('error', (error) => {
      if (state.cancelled) {
        finish({ ok: false, cancelled: true, paused: state.paused, files: [], bytes: 0 });
      } else {
        finish({ ok: false, error: safeText(normalizeSpawnError(error, resolved.path).message, 1200), files: [], bytes: 0 });
      }
    });

    child.once('close', (code) => {
      if (state.cancelled) {
        finish({ ok: false, cancelled: true, paused: state.paused, files: [], bytes: 0 });
        return;
      }
      const counted = settleFiles(code);
      if (code === 0) {
        finish({ ok: true, engine: 'yt-dlp', engine_path: resolved.path, files: counted.files, bytes: counted.bytes, exit_code: code });
      } else {
        const diagnosis = classifyParseError(errorText.trim() || ('下载失败，代码 ' + code), spec.site, 'yt-dlp');
        finish({
          ok: false,
          error: diagnosis.message,
          kind: diagnosis.kind,
          remedies: diagnosis.remedies,
          files: counted.files,
          bytes: counted.bytes,
          exit_code: code,
        });
      }
    });
  });
}

// 图片链路：gallery-dl 能直接落盘（保留原作者目录），失败时回退内置取图器。
function runGalleryDlDownload(spec, hooks) {
  const h = hooks || {};
  const opts = spec.engineOptions || {};
  const resolved = resolveEnginePath('gallery-dl', opts);
  if (!resolved) {
    return Promise.resolve({ ok: false, error: '本机找不到 gallery-dl，无法下载图片。', code: 'engine_missing', files: [], bytes: 0 });
  }
  const before = listFiles(spec.outputDir, { maxDepth: 4 });
  const startedAt = Date.now();
  const args = ['--no-colors', '-D', spec.outputDir];
  if (spec.cookieFile) args.push('--cookies', spec.cookieFile);
  if (spec.site && spec.site.userAgent) args.push('--user-agent', spec.site.userAgent);
  args.push(spec.url);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolved.path, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: safeText(error.message, 600), code: 'spawn_failed', files: [], bytes: 0 });
      return;
    }
    const state = { cancelled: false, paused: false, child, args, cookieFile: spec.cookieFile };
    if (typeof h.onChild === 'function') h.onChild(state);
    let errorText = '';
    let settled = false;
    let done = 0;

    const lines = createLineConsumer((line) => {
      try {
        const hit = /File \d+ (?:already downloaded|downloaded)/i.exec(line);
        if (hit) {
          done += 1;
          if (typeof h.onProgress === 'function') h.onProgress({ type: 'progress', percent: '', speed: '', eta: '第 ' + done + ' 个' });
        }
        if (typeof h.onLog === 'function') h.onLog(safeText(line, 500));
      } catch (error) {
        if (typeof h.onLog === 'function') h.onLog('[line parse failed] ' + safeText(error && error.message, 120));
      }
    });

    const finish = (r) => {
      if (settled) return;
      settled = true;
      lines.flush();
      resolve(r);
    };

    child.stdout.on('data', (c) => lines.push(c.toString('utf8')));
    child.stderr.on('data', (c) => {
      errorText = appendTail(errorText, c.toString('utf8'));
      lines.push(c.toString('utf8'));
    });
    child.once('error', (error) => finish({
      ok: false,
      cancelled: state.cancelled || undefined,
      error: safeText(error.message, 800),
      files: [],
      bytes: 0,
    }));
    child.once('close', (code) => {
      if (state.cancelled) {
        finish({ ok: false, cancelled: true, paused: state.paused, files: [], bytes: 0 });
        return;
      }
      const fresh = diffFiles(before, listFiles(spec.outputDir, { maxDepth: 4, sinceMs: startedAt }));
      const bytes = fresh.reduce((sum, f) => sum + f.bytes, 0);
      if (code === 0 && fresh.length) {
        finish({ ok: true, engine: 'gallery-dl', engine_path: resolved.path, files: fresh, bytes, exit_code: code });
      } else if (code === 0) {
        finish({ ok: true, engine: 'gallery-dl', engine_path: resolved.path, files: [], bytes: 0, exit_code: code, note: 'gallery-dl 正常结束，但没有新增文件（可能已全部下载过）。' });
      } else {
        const diagnosis = classifyParseError(errorText.trim() || ('gallery-dl 退出，代码 ' + code), spec.site, 'gallery-dl');
        finish({ ok: false, error: diagnosis.message, kind: diagnosis.kind, remedies: diagnosis.remedies, files: fresh, bytes });
      }
    });
  });
}

// 内置取图器（不依赖 gallery-dl）：用于图片列表已被解析出来的情形。
async function runImageListDownload(spec, hooks) {
  const h = hooks || {};
  const state = { cancelled: false, paused: false, child: null };
  if (typeof h.onChild === 'function') h.onChild(state);
  const images = (Array.isArray(spec.images) ? spec.images : []).slice(0, 500);
  const baseName = sanitizeFileName(spec.title || 'image', 80);
  const targetDir = ensureDirSync(path.join(spec.outputDir, spec.subfolder ? sanitizeFileName(spec.title || 'album', 60) : '.'));
  const headers = {
    'User-Agent': BROWSER_UA,
    ...(spec.cookieHeader ? { Cookie: spec.cookieHeader } : {}),
    Referer: safeText(spec.refererOrigin, 300) ? spec.refererOrigin + '/' : undefined,
  };
  const startedAt = Date.now();
  const files = [];
  let bytes = 0;

  for (const image of images) {
    if (state.cancelled) return { ok: false, cancelled: true, paused: state.paused, files, bytes };
    const url = safeText(image && image.url, 4096).trim();
    if (!isHttpUrl(url)) continue;
    if (typeof h.onProgress === 'function') {
      h.onProgress({
        type: 'progress',
        percent: Math.round((files.length / images.length) * 100) + '%',
        speed: '',
        eta: '第 ' + (files.length + 1) + '/' + images.length + ' 张',
      });
    }
    try {
      const buffer = await fetchBuffer(url, headers, 0, 100 * 1024 * 1024);
      if (!buffer.length) throw new Error('图片内容为空');
      const ext = safeExt(image.ext) || 'jpg';
      const fileName = baseName + '-' + String(files.length + 1).padStart(2, '0');
      const dest = uniquePath(targetDir, fileName, ext);
      await fs.promises.writeFile(dest, buffer);
      files.push({ path: dest, bytes: buffer.length, mtimeMs: Date.now() });
      bytes += buffer.length;
    } catch (error) {
      if (state.cancelled) return { ok: false, cancelled: true, paused: state.paused, files, bytes };
      return {
        ok: false,
        error: '第 ' + (files.length + 1) + ' 张图片下载失败：' + safeText(error.message, 200),
        kind: 'network',
        files,
        bytes,
      };
    }
  }
  if (!files.length) return { ok: false, error: '没有成功保存任何图片。', kind: 'no_formats', files, bytes, started_at: new Date(startedAt).toISOString() };
  return { ok: true, engine: '内置取图器', files, bytes };
}

function buildCookieHeader(site, cookies, url) {
  let target;
  try {
    target = new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => {
      const domain = safeText(cookie.domain, 200).replace(/^\./, '').toLowerCase();
      return target === domain || target.endsWith('.' + domain);
    })
    .map((cookie) => cookie.name + '=' + cookie.value)
    .join('; ');
}

// ── 本机存储：设置 / 历史 / 登录态（全在 userData，不在仓库）───────────────
function dataPaths(root) {
  return {
    root,
    settings: path.join(root, 'settings.json'),
    history: path.join(root, 'history.json'),
    authState: path.join(root, 'auth-state.json'),
    cookieDir: path.join(root, 'cookies'),
  };
}

const DEFAULT_SETTINGS = {
  outputDir: '',
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  subfolderByPost: false,
  concurrency: 2,
  autoRetry: 2,
  enginePreference: 'auto',
  audioFormat: 'mp3',
  exportCookiesForCli: false,
  // 引擎所在目录（打包版的 resources/bin）。留空则按 env -> 项目内 resources -> PATH 找。
  enginesDir: '',
};

function readJsonFile(file, fallback) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(file, value) {
  ensureDirSync(path.dirname(file));
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
  return value;
}

function readSettings(root) {
  const stored = readJsonFile(dataPaths(root).settings, {});
  return readSettingsFromValue(stored);
}

function writeSettings(root, patch) {
  const current = readSettings(root);
  const next = { ...current, ...patch };
  const merged = readSettingsFromValue(next);
  const storable = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) storable[key] = merged[key];
  writeJsonFile(dataPaths(root).settings, storable);
  return merged;
}

function readSettingsFromValue(value) {
  const merged = { ...DEFAULT_SETTINGS, ...value };
  if (typeof merged.enginesDir !== 'string') merged.enginesDir = '';
  merged.enginesDir = safeText(merged.enginesDir, 1024).trim();
  merged.concurrency = clampInt(merged.concurrency, 1, 4, 2);
  merged.autoRetry = clampInt(merged.autoRetry, 0, 5, 2);
  if (!['auto', 'yt-dlp', 'gallery-dl'].includes(merged.enginePreference)) merged.enginePreference = 'auto';
  if (!AUDIO_FORMATS.includes(merged.audioFormat)) merged.audioFormat = 'mp3';
  if (typeof merged.subfolderByPost !== 'boolean') merged.subfolderByPost = false;
  if (typeof merged.exportCookiesForCli !== 'boolean') merged.exportCookiesForCli = false;
  const template = validateFilenameTemplate(merged.filenameTemplate);
  merged.filename_template_error = template.ok ? '' : template.error;
  if (!template.ok) {
    merged.filenameTemplate = DEFAULT_FILENAME_TEMPLATE;
  }
  merged.output_dir_is_absolute = Boolean(merged.outputDir) && path.isAbsolute(merged.outputDir);
  return merged;
}

const HISTORY_LIMIT = 200;

function readHistory(root) {
  const stored = readJsonFile(dataPaths(root).history, {});
  return Array.isArray(stored.items) ? stored.items : [];
}

function appendHistory(root, entry) {
  const items = readHistory(root);
  const normalized = {
    id: safeText(entry.id, 40) || String(Date.now()),
    url: safeText(entry.url, 1024),
    title: safeText(entry.title, 300),
    engine: safeText(entry.engine, 20),
    mode: DOWNLOAD_MODES.includes(entry.mode) ? entry.mode : '',
    site: safeText(entry.site, 24),
    status: ['done', 'failed', 'cancelled', 'paused'].includes(entry.status) ? entry.status : 'done',
    output_dir: safeText(entry.outputDir, 1024),
    files: (Array.isArray(entry.files) ? entry.files : []).slice(0, 60).map((f) => ({
      path: safeText(f.path, 1024),
      bytes: Number(f.bytes) || 0,
    })),
    bytes: Number(entry.bytes) || 0,
    error: safeText(entry.error, 500),
    attempts: Number(entry.attempts) || 1,
    finished_at: entry.finished_at || new Date().toISOString(),
  };
  const next = [normalized].concat(items.filter((item) => item.id !== normalized.id)).slice(0, HISTORY_LIMIT);
  writeJsonFile(dataPaths(root).history, { items: next, limit: HISTORY_LIMIT });
  return normalized;
}

function clearHistory(root) {
  writeJsonFile(dataPaths(root).history, { items: [], limit: HISTORY_LIMIT });
  return true;
}

function readAuthState(root) {
  const stored = readJsonFile(dataPaths(root).authState, {});
  return stored && typeof stored === 'object' ? stored : {};
}

function writeAuthState(root, state) {
  writeJsonFile(dataPaths(root).authState, state);
  return state;
}

function authStateForSite(root, siteId, summary) {
  const state = readAuthState(root);
  state[siteId] = { ...summary, checked_at: new Date().toISOString() };
  state.updated_at = new Date().toISOString();
  return writeAuthState(root, state);
}

// 导出给命令行用的 Cookie 文件（用户显式开关，0600，只在本机）。
function exportSiteCookies(root, site, cookies) {
  const paths = dataPaths(root);
  const content = buildNetscapeCookieFile(site, cookies);
  if (!content) return { ok: false, error: '没有可用于该站点的登录 Cookie。' };
  ensureDirSync(paths.cookieDir);
  const file = path.join(paths.cookieDir, site.exportName);
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
  return { ok: true, path: file, cookie_count: content.split(LF).length - 3 };
}

function removeExportedCookies(root, siteId) {
  const site = LOGIN_SITES[siteId];
  if (!site) return false;
  const file = path.join(dataPaths(root).cookieDir, site.exportName);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function exportedCookieFile(root, siteId) {
  const site = LOGIN_SITES[siteId];
  if (!site) return '';
  const file = path.join(dataPaths(root).cookieDir, site.exportName);
  return cookieFileUsable(file) ? file : '';
}

// agent 侧无 Electron session：用导出的 Netscape 文件重建登录态摘要（仍只报状态）。
function authSnapshotFromExports(root) {
  const out = {};
  for (const siteId of SITE_IDS) {
    const site = LOGIN_SITES[siteId];
    const file = exportedCookieFile(root, siteId);
    if (!file) {
      out[siteId] = { loggedIn: false, exported: false, checked_at: '' };
      continue;
    }
    const cookies = parseNetscapeCookieFile(file);
    const summary = summarizeLoginCookies(site, cookies || []);
    out[siteId] = { ...summary, exported: true, checked_at: new Date(fs.statSync(file).mtimeMs).toISOString() };
  }
  return { sites: out, updated_at: new Date().toISOString(), source: 'exported_cookie_files' };
}

module.exports = {
  LOGIN_SITES,
  SITE_IDS,
  siteCatalog,
  DEFAULT_FILENAME_TEMPLATE,
  DEFAULT_SETTINGS,
  TEMPLATE_FIELDS,
  IMAGE_EXTENSIONS,
  isHttpUrl,
  normalizeMediaUrl,
  isSiteUrl,
  matchLoginSite,
  safeText,
  safeExt,
  formatBytes,
  formatSize,
  formatDuration,
  sanitizeFileName,
  uniquePath,
  ensureDirSync,
  validateFilenameTemplate,
  previewFilename,
  resolveEnginePath,
  probeEngine,
  probeEngines,
  runTool,
  runPromise: runTool,
  EngineError,
  terminateProcessTree,
  appendTail,
  createLineConsumer,
  isSiteCookie,
  buildNetscapeCookieFile,
  writeTempCookieFile,
  removeCookieFile,
  parseNetscapeCookieFile,
  cookieFileUsable,
  summarizeLoginCookies,
  fetchBuffer,
  fetchThumbnailDataUrl,
  mapFormats,
  parseGalleryDlJson,
  planEngine,
  analyzeWithYtDlp,
  analyzeWithGalleryDl,
  analyzeUrl,
  classifyParseError,
  buildDownloadArgs,
  listFiles,
  diffFiles,
  DESTINATION_PATTERNS,
  extractDestination,
  parseEngineLine,
  isEngineTempFile,
  scanEngineTempFiles,
  removeEngineTempFiles,
  enginesDirStatus,
  runEngineDownload,
  runGalleryDlDownload,
  runImageListDownload,
  buildCookieHeader,
  dataPaths,
  readSettings,
  writeSettings,
  readSettingsFromValue,
  readHistory,
  appendHistory,
  clearHistory,
  readAuthState,
  writeAuthState,
  authStateForSite,
  exportSiteCookies,
  removeExportedCookies,
  exportedCookieFile,
  authSnapshotFromExports,
  clampInt,
  AUDIO_FORMATS,
  DOWNLOAD_MODES,
};
