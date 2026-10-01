const { app, BrowserWindow, clipboard, dialog, ipcMain, net, session, shell } = require('electron');
const https = require('node:https');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createAgentApiServer, DEFAULT_API_PORT } = require('./agent-api.cjs');

let mainWindow;
let activeDownload = null;

const LOGIN_SITES = {
  douyin: {
    id: 'douyin',
    domains: ['douyin.com'],
    title: '登录抖音',
    homeUrl: 'https://www.douyin.com/',
    partition: 'persist:qydouyin',
    sessionCookieNames: ['sessionid', 'sessionid_ss', 'sid_guard'],
    filePrefix: 'qingying-douyin-',
    statusChannel: 'douyin:login-status',
    loginRequired: true,
    loginPrompt: '请先点击“抖音内容需要先登录”，完成登录后再解析。',
    reloginPrompt: '抖音登录已失效，请重新登录。'
  },
  tiktok: {
    id: 'tiktok',
    domains: ['tiktok.com'],
    title: '登录 TikTok',
    homeUrl: 'https://www.tiktok.com/',
    partition: 'persist:qytiktok',
    sessionCookieNames: ['sessionid', 'sessionid_ss', 'sid_guard'],
    filePrefix: 'qingying-tiktok-',
    statusChannel: 'tiktok:login-status',
    loginRequired: false,
    loginPrompt: 'TikTok 部分内容需要登录，请先点击“登录 TikTok”后再解析。',
    reloginPrompt: 'TikTok 登录已失效，请重新登录。',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
  },
  bilibili: {
    id: 'bilibili',
    domains: ['bilibili.com', 'b23.tv'],
    title: '登录哔哩哔哩',
    homeUrl: 'https://www.bilibili.com/',
    partition: 'persist:qybilibili',
    sessionCookieNames: ['SESSDATA', 'DedeUserID'],
    filePrefix: 'qingying-bilibili-',
    statusChannel: 'bilibili:login-status',
    loginRequired: false,
    loginPrompt: '请先点击“登录哔哩哔哩”，完成登录后再解析。',
    reloginPrompt: '哔哩哔哩登录已失效，请重新登录。',
    cookieHint: '哔哩哔哩风控较严，建议先点击“登录哔哩哔哩”，在弹出的窗口中打开过站点后再重试。'
  },
  xiaohongshu: {
    id: 'xiaohongshu',
    domains: ['xiaohongshu.com', 'xhslink.com'],
    title: '登录小红书',
    homeUrl: 'https://www.xiaohongshu.com/',
    partition: 'persist:qyxhs',
    sessionCookieNames: ['web_session'],
    filePrefix: 'qingying-xhs-',
    statusChannel: 'xiaohongshu:login-status',
    loginRequired: false,
    loginPrompt: '请先点击“登录小红书”，完成登录后再解析。',
    reloginPrompt: '小红书登录已失效，请重新登录。',
    cookieHint: '小红书部分内容需要登录，建议先点击“登录小红书”，在弹出的窗口中打开过站点后再重试。'
  },
  instagram: {
    id: 'instagram',
    domains: ['instagram.com', 'instagr.am', 'ddinstagram.com'],
    title: '登录 Instagram',
    homeUrl: 'https://www.instagram.com/',
    partition: 'persist:qyinsta',
    sessionCookieNames: ['sessionid', 'ds_user_id'],
    filePrefix: 'qingying-instagram-',
    statusChannel: 'instagram:login-status',
    loginRequired: false,
    loginPrompt: 'Instagram 需要登录后才能获取内容，请先点击“登录 Instagram”完成登录。',
    reloginPrompt: 'Instagram 登录已失效，请重新登录。',
    cookieHint: 'Instagram 现在强制要求登录，请先点击“登录 Instagram”完成登录后重试。'
  }
};
const loginWindows = {};

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 780,
    minHeight: 620,
    show: false,
    title: '清影下载器',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'app-icon.png'),
    backgroundColor: '#06101c',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  for (const ev of ['maximize', 'unmaximize']) {
    mainWindow.on(ev, () => mainWindow?.webContents.send('window:maximized', ev === 'maximize'));
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

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
  if (isDouyin && modalId && /^\d{10,25}$/.test(modalId)) {
    return `https://www.douyin.com/video/${modalId}`;
  }
  return parsed.toString();
}

function isSiteUrl(value, site) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return site.domains.some((domain) =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

function matchLoginSite(value) {
  for (const site of Object.values(LOGIN_SITES)) {
    if (isSiteUrl(value, site)) return site;
  }
  return null;
}

function openLogin(site) {
  const existing = loginWindows[site.id];
  if (existing && !existing.isDestroyed()) {
    existing.focus();
    return;
  }

  const loginWindow = new BrowserWindow({
    parent: mainWindow,
    width: 1050,
    height: 760,
    title: site.title,
    autoHideMenuBar: true,
    webPreferences: {
      partition: site.partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  loginWindows[site.id] = loginWindow;

  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isSiteUrl(targetUrl, site)) return;
    event.preventDefault();
  });
  loginWindow.loadURL(site.homeUrl);
  loginWindow.on('closed', async () => {
    delete loginWindows[site.id];
    const cookies = await session.fromPartition(site.partition).cookies.get({});
    const loggedIn = cookies.some((cookie) =>
      isSiteCookie(cookie, site)
      && site.sessionCookieNames.includes(cookie.name)
    );
    sendToMain(site.statusChannel, { loggedIn });
  });
}

function isSiteCookie(cookie, site) {
  const cookieDomain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
  return site.domains.some((domain) =>
    cookieDomain === domain || cookieDomain.endsWith(`.${domain}`)
  );
}

async function createSiteCookieFile(site) {
  const cookies = await session.fromPartition(site.partition).cookies.get({});
  const siteCookies = cookies.filter((cookie) => isSiteCookie(cookie, site));
  if (!siteCookies.length) return '';

  const lines = ['# Netscape HTTP Cookie File'];
  for (const cookie of siteCookies) {
    const domain = cookie.domain || `.${site.domains[0]}`;
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = Math.max(0, Math.floor(cookie.expirationDate || 0));
    const name = String(cookie.name || '').replace(/[\t\r\n]/g, '');
    const value = String(cookie.value || '').replace(/[\t\r\n]/g, '');
    lines.push([domain, includeSubdomains, cookie.path || '/', secure, expires, name, value].join('\t'));
  }

  const cookiePath = path.join(
    app.getPath('temp'),
    `${site.filePrefix}${process.pid}-${Date.now()}.txt`
  );
  await fs.promises.writeFile(cookiePath, `${lines.join('\n')}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return cookiePath;
}

function deleteCookieFile(cookiePath) {
  if (!cookiePath) return;
  const tempRoot = path.resolve(app.getPath('temp'));
  const resolved = path.resolve(cookiePath);
  const filePrefixes = Object.values(LOGIN_SITES).map((site) => site.filePrefix);
  if (
    path.dirname(resolved) === tempRoot
    && filePrefixes.some((prefix) => path.basename(resolved).startsWith(prefix))
  ) {
    try {
      fs.unlinkSync(resolved);
    } catch {}
  }
}

function uniqueDownloadPath(dir, name, ext) {
  let candidate = path.join(dir, `${name}.${ext}`);
  let index = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${name} (${index}).${ext}`);
    index += 1;
  }
  return candidate;
}

function fetchImageBuffer(url, headers, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('重定向次数过多'));
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('图片地址无效'));
      return;
    }
    const request = (parsed.protocol === 'https:' ? https : require('node:http'))
      .get(parsed, { headers }, (response) => {
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          fetchImageBuffer(new URL(response.headers.location, parsed).toString(), headers, redirectCount + 1)
            .then(resolve, reject);
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 100 * 1024 * 1024) {
            request.destroy(new Error('图片内容过大'));
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

function safeText(value, max = 2000) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function safeExt(value) {
  const extension = safeText(value, 12).toLowerCase();
  return /^[a-z0-9]+$/.test(extension) ? extension : '';
}

function toolPath(name) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', `${name}.exe`);
  }
  if (name === 'yt-dlp') {
    const bundled = path.join(app.getAppPath(), 'resources', 'yt-dlp.exe');
    return fs.existsSync(bundled) ? bundled : 'yt-dlp';
  }
  if (name === 'gallery-dl') {
    const bundled = path.join(app.getAppPath(), 'resources', 'bin', 'gallery-dl.exe');
    return fs.existsSync(bundled) ? bundled : 'gallery-dl';
  }
  const ffmpegStatic = require('ffmpeg-static');
  return ffmpegStatic;
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore'
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

function appendTail(current, addition, maxLength = 65536) {
  const combined = current + addition;
  return combined.length > maxLength ? combined.slice(-maxLength) : combined;
}

function runTool(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs || 120000;
  const maxStdoutBytes = options.maxStdoutBytes || 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

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
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) => finish(() => {
      if (timedOut) {
        reject(new Error('连接超时，请检查网络后重试。'));
      } else if (outputTooLarge) {
        reject(new Error('解析结果过大，已停止处理。'));
      } else if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `工具退出，代码 ${code}`));
      }
    }));
  });
}

function createLineConsumer(onLine) {
  let remainder = '';
  return {
    push(chunk) {
      const lines = `${remainder}${chunk}`.split(/\r?\n/);
      remainder = lines.pop() || '';
      lines.filter(Boolean).forEach(onLine);
    },
    flush() {
      if (remainder) onLine(remainder);
      remainder = '';
    }
  };
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

async function fetchImageDataUrl(url, referer) {
  if (!isHttpUrl(url)) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...(isHttpUrl(referer) ? { Referer: referer } : {})
      }
    });
    if (!response.ok) return '';
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith('image/')) return '';
    const declaredSize = Number(response.headers.get('content-length')) || 0;
    if (declaredSize > 8 * 1024 * 1024) return '';
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return '';
    return `data:${contentType.split(';')[0]};base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

function mapFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const videoExtensions = new Set(['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv', 'avi', 'ts', '3gp']);
  const audioExtensions = new Set(['mp3', 'm4a', 'aac', 'opus', 'ogg', 'wav', 'flac']);
  const hasUnknownCodecs = (format) => !format.vcodec && !format.acodec;
  const rawVideos = formats
    .filter((format) =>
      (format.vcodec && format.vcodec !== 'none')
      || (hasUnknownCodecs(format) && videoExtensions.has(String(format.ext).toLowerCase()))
    )
    .map((format) => {
      const unknownMuxedSource = hasUnknownCodecs(format);
      return {
        id: String(format.format_id),
        ext: format.ext || '',
        resolution: format.resolution
          || (format.height ? `${format.width || '?'}×${format.height}` : '源文件'),
        height: Number(format.height) || 0,
        fps: Number(format.fps) || 0,
        codec: format.vcodec || '源编码',
        hasAudio: unknownMuxedSource || Boolean(format.acodec && format.acodec !== 'none'),
        size: formatSize(Number(format.filesize || format.filesize_approx)),
        note: format.format_note || '',
        score:
          (format.acodec === 'none' ? 100000 : 0)
          + (format.ext === 'mp4' ? 10000 : 0)
          + (Number(format.fps) || 0) * 100
          + (Number(format.tbr) || 0)
      };
    });

  const bestVideoByHeight = new Map();
  for (const item of rawVideos) {
    const key = item.height || item.resolution || 'unknown';
    const current = bestVideoByHeight.get(key);
    if (!current || item.score > current.score) bestVideoByHeight.set(key, item);
  }
  const videos = [...bestVideoByHeight.values()]
    .sort((a, b) => b.height - a.height || b.score - a.score)
    .slice(0, 10)
    .map(({ score, ...item }) => item);

  const rawAudios = formats
    .filter((format) =>
      (
        (!format.vcodec || format.vcodec === 'none')
        && format.acodec
        && format.acodec !== 'none'
      )
      || (hasUnknownCodecs(format) && audioExtensions.has(String(format.ext).toLowerCase()))
    )
    .map((format) => ({
      id: String(format.format_id),
      ext: format.ext || '',
      codec: format.acodec || '',
      abr: Number(format.abr) || 0,
      size: formatSize(Number(format.filesize || format.filesize_approx)),
      language: format.language || '',
      note: format.format_note || ''
    }))
    .sort((a, b) => b.abr - a.abr);

  const seenAudio = new Set();
  const audios = rawAudios.filter((item) => {
    const bitrateBand = item.abr ? Math.round(item.abr / 16) * 16 : 0;
    const key = `${item.ext}|${item.codec}|${bitrateBand}|${item.language}`;
    if (seenAudio.has(key)) return false;
    seenAudio.add(key);
    return true;
  }).slice(0, 8);

  return { videos, audios };
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif']);

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
      const ext = meta.extension
        || (payload.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1] ?? '');
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
      height: Number(meta.height) || 0
    }))
    .filter((item) => IMAGE_EXTENSIONS.has(item.ext));
}

async function analyzeImagesWithGalleryDl(url) {
  const site = matchLoginSite(url);
  let cookieFile = '';
  try {
    const args = ['-j', '--no-colors'];
    if (site) {
      cookieFile = await createSiteCookieFile(site);
      if (cookieFile) args.push('--cookies', cookieFile);
    }
    args.push(url);

    const { stdout } = await runTool(toolPath('gallery-dl'), args, { timeoutMs: 90000 });
    const images = parseGalleryDlJson(stdout).slice(0, 200);
    if (!images.length) return null;

    return {
      ok: true,
      data: {
        title: safeText(images[0].filename || '图片作品', 300),
        uploader: '',
        thumbnail: '',
        duration: 0,
        webpageUrl: url,
        sessionSite: site?.id || '',
        videos: [],
        audios: [],
        images
      }
    };
  } catch {
    return null;
  } finally {
    deleteCookieFile(cookieFile);
  }
}

async function buildSiteCookieHeader(site, url) {
  try {
    const cookies = await session.fromPartition(site.partition).cookies.get({});
    let target;
    try {
      target = new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
    return cookies
      .filter((cookie) => {
        const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
        return target === domain || target.endsWith(`.${domain}`);
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform
}));

ipcMain.handle('clipboard:read', () => safeText(clipboard.readText(), 4096));

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载目录'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('folder:open', async (_event, payload) => {
  const folder = safeText(payload?.folder, 1024);
  try {
    if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) return false;
  } catch {
    return false;
  }
  return (await shell.openPath(folder)) === '';
});

ipcMain.handle('douyin:login', () => {
  openLogin(LOGIN_SITES.douyin);
  return true;
});

ipcMain.handle('tiktok:login', () => {
  openLogin(LOGIN_SITES.tiktok);
  return true;
});

ipcMain.handle('instagram:login', () => {
  openLogin(LOGIN_SITES.instagram);
  return true;
});

ipcMain.handle('bilibili:login', () => {
  openLogin(LOGIN_SITES.bilibili);
  return true;
});

ipcMain.handle('xiaohongshu:login', () => {
  openLogin(LOGIN_SITES.xiaohongshu);
  return true;
});

async function analyzeMedia(payload) {
  const inputUrl = safeText(payload?.url, 4096).trim();
  const url = isHttpUrl(inputUrl) ? normalizeMediaUrl(inputUrl) : inputUrl;
  if (!isHttpUrl(url)) {
    return { ok: false, error: '请输入有效的 http/https 视频网址。' };
  }

  let cookieFile = '';
  try {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-colors',
      '--no-playlist',
      '--skip-download'
    ];
    const site = matchLoginSite(url);
    if (site) {
      if (site.userAgent) args.push('--user-agent', site.userAgent);
      cookieFile = await createSiteCookieFile(site);
      if (!cookieFile && site.loginRequired) {
        throw new Error(site.loginPrompt);
      }
      if (cookieFile) args.push('--cookies', cookieFile);
    }
    args.push(url);

    const { stdout } = await runTool(toolPath('yt-dlp'), args);
    const info = JSON.parse(stdout);
    const { videos, audios } = mapFormats(info);
    if (!videos.length && !audios.length) {
      // yt-dlp 能“解析”直链图片但没有可用的视频/音频格式，降级到 gallery-dl。
      const fallback = await analyzeImagesWithGalleryDl(url);
      if (fallback) return fallback;
    }
    const thumbnail = await fetchImageDataUrl(info.thumbnail || '', url);
    return {
      ok: true,
      data: {
        title: safeText(info.title || '未命名视频', 300),
        uploader: safeText(info.uploader || info.channel || '', 200),
        thumbnail,
        duration: Number(info.duration) || 0,
        webpageUrl: url,
        sessionSite: site?.id || '',
        videos,
        audios
      }
    };
  } catch (error) {
    const fallback = await analyzeImagesWithGalleryDl(url);
    if (fallback) return fallback;

    let message = safeText(error?.message, 1200) || '解析失败，请稍后重试。';
    const site = matchLoginSite(url);
    if (site?.cookieHint && !cookieFile) {
      message = `${message}（提示：${site.cookieHint}）`;
    }
    return {
      ok: false,
      error: message
    };
  } finally {
    deleteCookieFile(cookieFile);
  }
}

ipcMain.handle('media:analyze', (_event, payload) => analyzeMedia(payload));

async function downloadMedia(payload) {
  if (activeDownload) {
    return { ok: false, error: '已有下载任务正在进行。' };
  }

  const url = safeText(payload?.url, 4096).trim();
  const outputDir = safeText(payload?.outputDir, 1024);
  const mode = ['combined', 'video', 'audio', 'images'].includes(payload?.mode) ? payload.mode : '';
  const videoId = safeText(payload?.videoId, 80);
  const audioId = safeText(payload?.audioId, 80);
  const videoExt = safeExt(payload?.videoExt);
  const audioExt = safeExt(payload?.audioExt);
  const videoHasAudio = payload?.videoHasAudio === true;
  const audioFormat = ['mp3', 'm4a', 'opus', 'wav'].includes(payload?.audioFormat)
    ? payload.audioFormat
    : 'mp3';
  const sessionSite = LOGIN_SITES[payload?.sessionSite] || null;

  if (!isHttpUrl(url)) return { ok: false, error: '网址无效。' };
  if (sessionSite && !isSiteUrl(url, sessionSite)) {
    return { ok: false, error: '网址与所选站点不匹配。' };
  }

  try {
    if (!path.isAbsolute(outputDir) || !fs.statSync(outputDir).isDirectory()) {
      return { ok: false, error: '请选择有效的下载目录。' };
    }
  } catch {
    return { ok: false, error: '请选择有效的下载目录。' };
  }
  if (!mode) return { ok: false, error: '请选择下载模式。' };

  if (mode === 'images') {
    const imageList = (Array.isArray(payload?.images) ? payload.images : [])
      .map((item, index) => ({
        url: safeText(item?.url, 4096).trim(),
        ext: safeExt(item?.ext) || 'jpg',
        index: index + 1
      }))
      .filter((item) => isHttpUrl(item.url))
      .slice(0, 200);
    if (!imageList.length) return { ok: false, error: '没有可下载的图片。' };
    const baseName = safeText(payload?.title, 80)
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .trim() || 'image';

    let cookieHeader = '';
    if (sessionSite) cookieHeader = await buildSiteCookieHeader(sessionSite, url);

    return new Promise((resolve) => {
      let settled = false;
      activeDownload = { cancelled: false, child: null };

      const finish = (result) => {
        if (settled) return;
        settled = true;
        activeDownload = null;
        resolve(result);
      };

      (async () => {
        const total = imageList.length;
        for (const image of imageList) {
          if (activeDownload?.cancelled) {
            sendToMain('media:progress', { type: 'cancelled' });
            finish({ ok: false, cancelled: true });
            return;
          }
          const pct = Math.round(((image.index - 1) / total) * 100);
          sendToMain('media:progress', {
            type: 'progress',
            percent: `${pct}%`,
            speed: '',
            eta: `第 ${image.index}/${total} 张`
          });
          try {
            const buffer = await fetchImageBuffer(image.url, {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
              ...(cookieHeader ? { Cookie: cookieHeader } : {}),
              Referer: `${new URL(url).origin}/`
            });
            if (!buffer.length) throw new Error('图片内容为空');
            const fileName = `${baseName}-${String(image.index).padStart(2, '0')}`;
            const destPath = uniqueDownloadPath(outputDir, fileName, image.ext);
            await fs.promises.writeFile(destPath, buffer);
          } catch (imageError) {
            finish({
              ok: false,
              error: `第 ${image.index} 张图片下载失败：${safeText(imageError?.message, 200)}`
            });
            return;
          }
        }
        sendToMain('media:progress', { type: 'done' });
        finish({ ok: true });
      })();
    });
  }

  if (mode !== 'audio' && !videoId) return { ok: false, error: '请选择视频画质。' };
  if (mode === 'audio' && !audioId) return { ok: false, error: '请选择音频轨道。' };
  if (mode === 'combined' && !videoHasAudio && !audioId) {
    return { ok: false, error: '请选择用于合并的音频轨道。' };
  }

  let cookieFile = '';
  if (sessionSite) {
    cookieFile = await createSiteCookieFile(sessionSite);
    if (!cookieFile && sessionSite.loginRequired) {
      return { ok: false, error: sessionSite.reloginPrompt };
    }
  }

  const args = [
    '--newline',
    '--no-playlist',
    '--no-warnings',
    '--no-colors',
    '--windows-filenames',
    '--continue',
    '--retries', '20',
    '--fragment-retries', '20',
    '--retry-sleep', '2',
    '--socket-timeout', '30',
    '--concurrent-fragments', '1',
    '--ffmpeg-location', toolPath('ffmpeg'),
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(outputDir, '%(title).180B [%(id)s].%(ext)s')
  ];
  if (sessionSite?.userAgent) args.push('--user-agent', sessionSite.userAgent);
  if (cookieFile) args.push('--cookies', cookieFile);

  if (mode === 'combined') {
    if (videoHasAudio) {
      args.push('-f', videoId);
    } else {
      const mp4Compatible =
        videoExt === 'mp4' && ['m4a', 'mp4', 'aac'].includes(audioExt);
      args.push(
        '-f',
        `${videoId}+${audioId}`,
        '--merge-output-format',
        mp4Compatible ? 'mp4' : 'mkv'
      );
    }
  } else if (mode === 'video') {
    args.push('-f', videoId);
  } else {
    args.push('-f', audioId, '-x', '--audio-format', audioFormat);
  }
  args.push(url);

  return new Promise((resolve) => {
    const child = spawn(toolPath('yt-dlp'), args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const record = {
      child,
      cookieFile,
      cancelled: false
    };
    activeDownload = record;

    let errorText = '';
    let settled = false;

    const handleLine = (line, kind) => {
      if (line.startsWith('download:')) {
        const [percent, speed, eta] = line.slice(9).split('|');
        sendToMain('media:progress', {
          type: 'progress',
          percent: safeText(percent, 20).trim(),
          speed: safeText(speed, 30).trim(),
          eta: safeText(eta, 30).trim()
        });
      } else {
        sendToMain('media:progress', {
          type: kind,
          message: safeText(line, 500)
        });
      }
    };

    const stdoutLines = createLineConsumer((line) => handleLine(line, 'log'));
    const stderrLines = createLineConsumer((line) => handleLine(line, 'log'));

    const finish = (result) => {
      if (settled) return;
      settled = true;
      stdoutLines.flush();
      stderrLines.flush();
      if (activeDownload === record) activeDownload = null;
      deleteCookieFile(cookieFile);
      resolve(result);
    };

    child.stdout.on('data', (chunk) => stdoutLines.push(chunk.toString('utf8')));
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      errorText = appendTail(errorText, text);
      stderrLines.push(text);
    });
    child.once('error', (error) => {
      if (record.cancelled) {
        sendToMain('media:progress', { type: 'cancelled' });
        finish({ ok: false, cancelled: true });
      } else {
        finish({ ok: false, error: safeText(error.message, 1200) });
      }
    });
    child.once('close', (code) => {
      if (record.cancelled) {
        sendToMain('media:progress', { type: 'cancelled' });
        finish({ ok: false, cancelled: true });
      } else if (code === 0) {
        sendToMain('media:progress', { type: 'done' });
        finish({ ok: true });
      } else {
        finish({
          ok: false,
          error: safeText(errorText.trim(), 1200) || `下载失败，代码 ${code}`
        });
      }
    });
  });
}

ipcMain.handle('media:download', (_event, payload) => downloadMedia(payload));

// ── 窗口控制（自绘标题栏）──

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => !!mainWindow?.isMaximized());

ipcMain.handle('media:cancel', () => {
  if (!activeDownload) return false;
  if (activeDownload.cancelled) return true;
  activeDownload.cancelled = true;
  terminateProcessTree(activeDownload.child);
  return true;
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.qingying.downloader');
    createWindow();
    // Agent API：复用应用内解析/下载流程与各站点登录会话；端口被占用时静默跳过。
    try {
      const apiPort = Number(process.env.QINGYING_API_PORT) || DEFAULT_API_PORT;
      const server = createAgentApiServer({
        analyzeMedia,
        downloadMedia,
        version: app.getVersion(),
      });
      server.on('error', () => {});
      server.listen(apiPort, '127.0.0.1', () => {
        console.log(`[qingying-agent-api] listening on http://127.0.0.1:${apiPort}`);
      });
    } catch (_) {}
  });
}

app.on('before-quit', () => {
  if (activeDownload) {
    activeDownload.cancelled = true;
    deleteCookieFile(activeDownload.cookieFile);
    terminateProcessTree(activeDownload.child);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
