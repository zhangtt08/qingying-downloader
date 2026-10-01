const { app, BrowserWindow, clipboard, dialog, ipcMain, net, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const core = require('./engine-core.cjs');
const { createAgentApiServer, DEFAULT_API_PORT } = require('./agent-api.cjs');

const LOGIN_SITES = core.LOGIN_SITES;
const SITE_IDS = core.SITE_IDS;

let mainWindow;
let enginesCache = null;
const loginWindows = {};

// ── 本机数据目录（全部在 userData，仓库里没有）─────────────────────────────
const DATA_DIR = () => path.join(app.getPath('userData'), 'qingying');
const TEMP_DIR = () => app.getPath('temp');

function sendToMain(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 800,
    minHeight: 640,
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
      webSecurity: true,
    },
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

// ── 引擎位置 ──────────────────────────────────────────────────────────────
function engineOptions() {
  const overrides = {};
  const roots = [];
  if (app.isPackaged) {
    const bin = path.join(process.resourcesPath, 'bin');
    overrides['yt-dlp'] = path.join(bin, 'yt-dlp.exe');
    overrides['gallery-dl'] = path.join(bin, 'gallery-dl.exe');
    overrides['ffmpeg'] = path.join(bin, 'ffmpeg.exe');
  } else {
    roots.push(path.join(app.getAppPath(), 'resources', 'bin'));
    roots.push(path.join(app.getAppPath(), 'resources'));
  }
  // 用户在设置里指定的引擎目录（例如安装包里的 resources/bin）。
  const configured = core.readSettings(DATA_DIR()).enginesDir;
  if (configured) roots.unshift(configured);
  return { overrides, extraRoots: roots };
}

function ffmpegLocation() {
  const resolved = core.resolveEnginePath('ffmpeg', engineOptions());
  if (resolved) return resolved.path;
  try {
    const staticFfmpeg = require('ffmpeg-static');
    if (staticFfmpeg) return staticFfmpeg;
  } catch {}
  return 'ffmpeg';
}

async function probeEngines() {
  enginesCache = await core.probeEngines(engineOptions());
  return enginesCache;
}

// ── 登录态：Cookie 只在进程内出现，落盘的只有状态摘要 ───────────────────────
async function siteCookies(site) {
  try {
    return await session.fromPartition(site.partition).cookies.get({});
  } catch {
    return [];
  }
}

async function cookieFileForSite(site) {
  if (!site) return '';
  return core.writeTempCookieFile(site, await siteCookies(site), TEMP_DIR());
}

function releaseCookieFile(file) {
  return core.removeCookieFile(file, TEMP_DIR());
}

async function collectAuthSnapshot() {
  const sites = {};
  for (const siteId of SITE_IDS) {
    const site = LOGIN_SITES[siteId];
    const summary = core.summarizeLoginCookies(site, await siteCookies(site));
    // 分区目录存在 = 这个站点在这个应用里开过登录窗口（没有分区就是从没碰过）。
    let hasPartition = false;
    try {
      hasPartition = fs.existsSync(path.join(app.getPath('userData'), 'Partitions', site.partition.replace('persist:', '')));
    } catch {}
    sites[siteId] = {
      logged_in: summary.loggedIn,
      matched_cookie_names: summary.matchedCookieNames,
      cookie_count: summary.cookieCount,
      expired_detected: summary.expiredDetected,
      expires_at: summary.earliestExpiry,
      label: site.label,
      login_required: site.loginRequired,
      home_url: site.homeUrl,
      has_partition: hasPartition,
      exported: Boolean(core.exportedCookieFile(DATA_DIR(), siteId)),
      checked_at: new Date().toISOString(),
    };
  }
  const snapshot = { sites, updated_at: new Date().toISOString(), source: 'electron_session' };
  core.writeAuthState(DATA_DIR(), snapshot);
  return snapshot;
}

// ── 解析 ──────────────────────────────────────────────────────────────────
async function analyzeMedia(payload) {
  const url = safeUrl(payload?.url);
  if (!url) return { ok: false, error: '请输入有效的 http/https 网址。', kind: 'bad_url' };
  const engines = enginesCache || (await probeEngines());
  const settings = core.readSettings(DATA_DIR());
  // cookieProvider 交出去的临时文件由调用方负责删除（core 不猜测文件生命周期）。
  const createdCookies = [];
  let result;
  try {
    result = await core.analyzeUrl({
      url,
      engines,
      preference: core.safeText(payload?.engine_preference, 20) || settings.enginePreference,
      cookieProvider: async (site) => {
        const file = await cookieFileForSite(site);
        if (file) createdCookies.push(file);
        return file;
      },
      fetchThumbnail: (target, init) => net.fetch(target, init),
    });
  } finally {
    for (const file of createdCookies) releaseCookieFile(file);
  }
  if (result.ok) emitEngines();
  return result;
}

function safeUrl(value) {
  const text = core.safeText(value, 4096).trim();
  return core.isHttpUrl(text) ? core.normalizeMediaUrl(text) : '';
}

// ── 下载队列 ──────────────────────────────────────────────────────────────
// 状态机：queued -> downloading -> (done | failed | cancelled | paused)
// retrying 是 downloading 的延迟重排，不算独立状态但会显示次数。
// 暂停 = 终止引擎进程并保留 .part 分片；继续 = 用同一批参数重跑，yt-dlp 的
// --continue 会接着已下载的分片走，不是从头再来。
const tasks = new Map();
const taskOrder = [];
let runningCount = 0;
let taskSeq = 0;

const NON_RETRYABLE = new Set(['login_required', 'engine_missing', 'bad_url', 'needs_login']);

function makeTask(input) {
  taskSeq += 1;
  const settings = core.readSettings(DATA_DIR());
  const id = 'q' + Date.now().toString(36) + '-' + taskSeq;
  const task = {
    id,
    url: safeUrl(input.url),
    title: core.safeText(input.title, 300) || '未命名内容',
    mode: core.DOWNLOAD_MODES.includes(input.mode) ? input.mode : 'combined',
    videoId: core.safeText(input.videoId, 80),
    videoExt: core.safeExt(input.videoExt),
    videoHasAudio: input.videoHasAudio === true,
    audioId: core.safeText(input.audioId, 80),
    audioExt: core.safeExt(input.audioExt),
    audioFormat: core.AUDIO_FORMATS.includes(input.audioFormat) ? input.audioFormat : settings.audioFormat,
    images: Array.isArray(input.images) ? input.images.slice(0, 500) : [],
    engine: ['yt-dlp', 'gallery-dl'].includes(input.engine) ? input.engine : '',
    site: LOGIN_SITES[input.site] ? input.site : '',
    outputDir: core.safeText(input.outputDir, 1024).trim() || settings.outputDir,
    status: 'queued',
    progress: { percent: '', speed: '', eta: '' },
    attempts: 0,
    max_attempts: 1 + core.clampInt(settings.autoRetry, 0, 5, 2),
    error: '',
    kind: '',
    remedies: [],
    files: [],
    bytes: 0,
    log: '',
    used_engine: '',
    created_at: new Date().toISOString(),
    started_at: '',
    finished_at: '',
    runner: null,
    timer: null,
  };
  tasks.set(id, task);
  taskOrder.push(id);
  while (taskOrder.length > 200) {
    const drop = taskOrder.shift();
    if (drop !== id) tasks.delete(drop);
  }
  return task;
}

function taskView(task) {
  return {
    id: task.id,
    url: task.url,
    title: task.title,
    mode: task.mode,
    engine: task.engine || '自动',
    used_engine: task.used_engine,
    site: task.site,
    status: task.status,
    progress: task.progress,
    attempts: task.attempts,
    max_attempts: task.max_attempts,
    error: task.error,
    kind: task.kind,
    remedies: task.remedies,
    file_count: task.files.length,
    files: task.files.slice(0, 12),
    bytes: task.bytes,
    size_text: core.formatBytes(task.bytes) || '',
    output_dir: task.outputDir,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
    log_tail: core.safeText(task.log, 400),
  };
}

function queueSnapshot() {
  return {
    tasks: taskOrder.map((id) => tasks.get(id)).filter(Boolean).map(taskView),
    running: runningCount,
    limit: core.readSettings(DATA_DIR()).concurrency,
    settings: publicSettings(),
    engines: enginesCache,
  };
}

let emitTimer = null;
function emitQueue(immediate = false) {
  const send = () => {
    emitTimer = null;
    sendToMain('queue:changed', queueSnapshot());
  };
  if (immediate) {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = null;
    send();
    return;
  }
  if (emitTimer) return;
  emitTimer = setTimeout(send, 160);
}

function emitEngines() {
  sendToMain('engines:changed', enginesCache);
}

function publicSettings() {
  const settings = core.readSettings(DATA_DIR());
  return {
    ...settings,
    cookie_export_available: SITE_IDS.filter((id) => core.exportedCookieFile(DATA_DIR(), id)).length,
    data_dir: DATA_DIR(),
  };
}

function pumpQueue() {
  const limit = core.readSettings(DATA_DIR()).concurrency;
  while (runningCount < limit) {
    const next = taskOrder.map((id) => tasks.get(id)).find((task) => task && task.status === 'queued');
    if (!next) break;
    void runTask(next);
  }
  emitQueue();
}

function validateTaskTarget(task) {
  if (!task.url) return '网址无效。';
  if (!core.isHttpUrl(task.url)) return '网址无效。';
  const site = task.site ? LOGIN_SITES[task.site] : null;
  if (site && !core.isSiteUrl(task.url, site)) return '网址与所选站点不匹配。';
  try {
    if (!path.isAbsolute(task.outputDir) || !fs.statSync(task.outputDir).isDirectory()) {
      return '请选择有效的下载目录。';
    }
  } catch {
    return '请选择有效的下载目录。';
  }
  if (task.mode !== 'images' && task.mode !== 'audio' && !task.videoId) return '请选择视频画质。';
  if (task.mode === 'audio' && !task.audioId) return '请选择音频轨道。';
  if (task.mode === 'combined' && !task.videoHasAudio && !task.audioId) return '请选择用于合并的音频轨道。';
  return '';
}

async function runTask(task) {
  if (task.status !== 'queued') return;
  const problem = validateTaskTarget(task);
  if (problem) {
    task.status = 'failed';
    task.error = problem;
    task.kind = 'bad_input';
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    return;
  }

  runningCount += 1;
  task.attempts += 1;
  task.status = 'downloading';
  task.error = '';
  task.kind = '';
  task.started_at = new Date().toISOString();
  emitQueue(true);

  const site = task.site ? LOGIN_SITES[task.site] : null;
  const cookieFile = await cookieFileForSite(site);
  const settings = core.readSettings(DATA_DIR());
  const engines = enginesCache || (await probeEngines());
  const opts = engineOptions();
  const hooks = {
    onChild: (state) => {
      task.runner = state;
    },
    onProgress: (payload) => {
      task.progress = {
        percent: core.safeText(payload.percent, 20).trim(),
        speed: core.safeText(payload.speed, 30).trim(),
        eta: core.safeText(payload.eta, 30).trim(),
      };
      emitQueue();
    },
    onLog: (line) => {
      task.log = core.appendTail(task.log, line + '\n', 4000);
    },
  };

  const commonSpec = {
    url: task.url,
    outputDir: task.outputDir,
    site,
    cookieFile,
    engineOptions: opts,
    ffmpegLocation: ffmpegLocation(),
    filenameTemplate: settings.filenameTemplate,
    subfolderByPost: settings.subfolderByPost,
    retries: 20,
    concurrentFragments: 3,
  };

  let result;
  try {
    if (task.mode === 'images') {
      const wantGallery = (task.engine === 'gallery-dl' || settings.enginePreference === 'gallery-dl')
        && engines.gallery_dl?.available;
      if (wantGallery) {
        result = await core.runGalleryDlDownload({ url: task.url, outputDir: task.outputDir, site, cookieFile }, hooks);
      } else {
        const cookieHeader = site ? core.buildCookieHeader(site, await siteCookies(site), task.url) : '';
        result = await core.runImageListDownload({
          url: task.url,
          outputDir: task.outputDir,
          images: task.images,
          title: task.title,
          subfolder: settings.subfolderByPost,
          cookieHeader,
          refererOrigin: safeOrigin(task.url),
        }, hooks);
      }
    } else {
      if (!engines.yt_dlp?.available) {
        result = { ok: false, kind: 'engine_missing', error: '本机找不到 yt-dlp，无法下载视频或音频。', files: [], bytes: 0 };
      } else {
        result = await core.runEngineDownload({
          ...commonSpec,
          mode: task.mode,
          videoId: task.videoId,
          videoExt: task.videoExt,
          videoHasAudio: task.videoHasAudio,
          audioId: task.audioId,
          audioExt: task.audioExt,
          audioFormat: task.audioFormat,
        }, hooks);
      }
    }
  } catch (error) {
    result = { ok: false, error: core.safeText(error?.message, 600), files: [], bytes: 0 };
  } finally {
    releaseCookieFile(cookieFile);
    runningCount = Math.max(0, runningCount - 1);
    task.runner = null;
  }

  task.files = result.files || [];
  task.bytes = Number(result.bytes) || 0;
  task.used_engine = result.engine || (task.mode === 'images' ? '内置取图器' : 'yt-dlp');

  if (result.ok) {
    task.status = 'done';
    task.progress = { percent: '100%', speed: '', eta: '' };
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    pumpQueue();
    return;
  }

  if (result.cancelled) {
    task.status = result.paused ? 'paused' : 'cancelled';
    if (task.status === 'paused') task.progress = { percent: task.progress.percent, speed: '', eta: '已暂停，分片保留在原目录' };
    task.finished_at = new Date().toISOString();
    recordHistory(task);
    emitQueue(true);
    pumpQueue();
    return;
  }

  task.error = result.error || '下载失败。';
  task.kind = result.kind || 'unknown';
  task.remedies = result.remedies || [];
  const retriable = !NON_RETRYABLE.has(task.kind) && task.attempts < task.max_attempts;
  if (retriable) {
    const delayMs = 2000 * task.attempts;
    task.status = 'queued';
    task.progress = { percent: task.progress.percent, speed: '', eta: `${delayMs / 1000} 秒后自动重试（第 ${task.attempts + 1}/${task.max_attempts} 次）` };
    task.timer = setTimeout(() => {
      task.timer = null;
      pumpQueue();
    }, delayMs);
    emitQueue(true);
    pumpQueue();
    return;
  }

  task.status = 'failed';
  task.finished_at = new Date().toISOString();
  recordHistory(task);
  emitQueue(true);
  pumpQueue();
}

function safeOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

function recordHistory(task) {
  try {
    core.appendHistory(DATA_DIR(), {
      id: task.id,
      url: task.url,
      title: task.title,
      engine: task.used_engine || task.engine,
      mode: task.mode,
      site: task.site,
      status: task.status,
      outputDir: task.outputDir,
      files: task.files,
      bytes: task.bytes,
      error: task.error,
      attempts: task.attempts,
      finished_at: task.finished_at,
    });
  } catch {}
}

function stopTask(task, { pause }) {
  if (!task) return false;
  if (task.timer) {
    clearTimeout(task.timer);
    task.timer = null;
  }
  if (task.status === 'queued') {
    task.status = pause ? 'paused' : 'cancelled';
    task.finished_at = new Date().toISOString();
    emitQueue(true);
    pumpQueue();
    return true;
  }
  if (task.status !== 'downloading') return false;
  if (task.runner) {
    task.runner.cancelled = true;
    task.runner.paused = Boolean(pause);
    core.terminateProcessTree(task.runner.child);
  }
  return true;
}

// ── IPC ───────────────────────────────────────────────────────────────────
ipcMain.handle('app:get-info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  data_dir: DATA_DIR(),
  packaged: app.isPackaged,
}));

ipcMain.handle('clipboard:read', () => core.safeText(clipboard.readText(), 4096));

ipcMain.handle('clipboard:write', (_event, payload) => {
  clipboard.writeText(core.safeText(payload?.text, 64 * 1024));
  return true;
});

ipcMain.handle('dialog:choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: '选择下载目录',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('folder:open', async (_event, payload) => {
  const folder = core.safeText(payload?.folder, 1024);
  try {
    if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) return false;
  } catch {
    return false;
  }
  return (await shell.openPath(folder)) === '';
});

ipcMain.handle('file:reveal', async (_event, payload) => {
  const file = core.safeText(payload?.file, 1024);
  if (!file || !path.isAbsolute(file) || !fs.existsSync(file)) return false;
  shell.showItemInFolder(file);
  return true;
});

ipcMain.handle('external:open', (_event, payload) => {
  const target = core.safeText(payload?.url, 2048).trim();
  if (!core.isHttpUrl(target)) return false;
  void shell.openExternal(target);
  return true;
});

ipcMain.handle('engines:probe', async () => {
  await probeEngines();
  emitEngines();
  return enginesCache;
});

ipcMain.handle('settings:get', () => publicSettings());

ipcMain.handle('settings:set', async (_event, payload) => {
  const patch = payload && typeof payload === 'object' ? payload : {};
  const allowed = {};
  if (typeof patch.outputDir === 'string') allowed.outputDir = core.safeText(patch.outputDir, 1024);
  if (typeof patch.filenameTemplate === 'string') allowed.filenameTemplate = core.safeText(patch.filenameTemplate, 200);
  if (typeof patch.subfolderByPost === 'boolean') allowed.subfolderByPost = patch.subfolderByPost;
  if (patch.concurrency !== undefined) allowed.concurrency = patch.concurrency;
  if (patch.autoRetry !== undefined) allowed.autoRetry = patch.autoRetry;
  if (typeof patch.enginePreference === 'string') allowed.enginePreference = patch.enginePreference;
  if (typeof patch.audioFormat === 'string') allowed.audioFormat = patch.audioFormat;
  if (typeof patch.exportCookiesForCli === 'boolean') allowed.exportCookiesForCli = patch.exportCookiesForCli;
  if (typeof patch.enginesDir === 'string') allowed.enginesDir = core.safeText(patch.enginesDir, 1024);
  const saved = core.writeSettings(DATA_DIR(), allowed);
  if ('enginesDir' in allowed) {
    await probeEngines();
    emitEngines();
  }
  const merged = publicSettings();
  if (saved.filename_template_error) {
    return { ok: false, error: saved.filename_template_error, settings: merged };
  }
  emitQueue(true);
  return { ok: true, settings: merged };
});

ipcMain.handle('template:preview', (_event, payload) => {
  const template = core.safeText(payload?.template, 200);
  const check = core.validateFilenameTemplate(template);
  if (!check.ok) return { ok: false, error: check.error };
  const sample = payload?.sample && typeof payload.sample === 'object' ? payload.sample : {};
  return { ok: true, preview: core.previewFilename(template, { title: '示例标题', id: 'BV1xx4y1A', ext: 'mp4', ...sample }) };
});

ipcMain.handle('history:list', () => ({ items: core.readHistory(DATA_DIR()) }));
ipcMain.handle('history:clear', () => {
  core.clearHistory(DATA_DIR());
  return { items: [] };
});

ipcMain.handle('media:analyze', (_event, payload) => analyzeMedia(payload));

ipcMain.handle('queue:submit', (_event, payload) => {
  const items = Array.isArray(payload?.items) ? payload.items.slice(0, 50) : [payload || {}];
  const created = [];
  for (const item of items) {
    const task = makeTask(item);
    created.push(taskView(task));
  }
  pumpQueue();
  return { ok: true, tasks: created };
});

ipcMain.handle('queue:pause', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  return stopTask(task, { pause: true });
});

ipcMain.handle('queue:resume', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  if (!task || (task.status !== 'paused' && task.status !== 'cancelled' && task.status !== 'failed')) return false;
  task.status = 'queued';
  task.error = '';
  task.kind = '';
  task.remedies = [];
  task.progress = { percent: '', speed: '', eta: '' };
  pumpQueue();
  return true;
});

ipcMain.handle('queue:retry', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  if (!task || (task.status !== 'failed' && task.status !== 'cancelled')) return false;
  task.status = 'queued';
  task.attempts = 0;
  task.error = '';
  task.kind = '';
  pumpQueue();
  return true;
});

ipcMain.handle('queue:cancel', (_event, payload) => {
  const task = tasks.get(core.safeText(payload?.id, 40));
  return stopTask(task, { pause: false });
});

ipcMain.handle('queue:remove', (_event, payload) => {
  const id = core.safeText(payload?.id, 40);
  const task = tasks.get(id);
  if (!task) return false;
  if (task.status === 'downloading') stopTask(task, { pause: false });
  if (task.timer) clearTimeout(task.timer);
  tasks.delete(id);
  const index = taskOrder.indexOf(id);
  if (index >= 0) taskOrder.splice(index, 1);
  emitQueue(true);
  return true;
});

ipcMain.handle('queue:clear-finished', () => {
  const finished = taskOrder.filter((id) => ['done', 'cancelled'].includes(tasks.get(id)?.status));
  for (const id of finished) {
    tasks.delete(id);
    const index = taskOrder.indexOf(id);
    if (index >= 0) taskOrder.splice(index, 1);
  }
  emitQueue(true);
  return { removed: finished.length };
});

ipcMain.handle('queue:list', () => queueSnapshot());

// ── 登录窗口与登录态开关 ──────────────────────────────────────────────────
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
      webSecurity: true,
    },
  });
  loginWindows[site.id] = loginWindow;

  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  loginWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (core.isSiteUrl(targetUrl, site)) return;
    event.preventDefault();
  });
  // 站点登录成功常表现为 session cookie 出现；这里不轮询页面，只在窗口关闭时确认一次。
  loginWindow.loadURL(site.homeUrl);
  loginWindow.on('closed', async () => {
    delete loginWindows[site.id];
    await refreshSiteStatus(site.id);
  });
}

async function refreshSiteStatus(siteId) {
  const site = LOGIN_SITES[siteId];
  if (!site) return null;
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return snapshot.sites[siteId] || null;
}

ipcMain.handle('auth:status', async () => collectAuthSnapshot());

ipcMain.handle('auth:login', (_event, payload) => {
  const site = LOGIN_SITES[core.safeText(payload?.site, 24)];
  if (!site) return { ok: false, error: '未知站点。' };
  openLogin(site);
  return { ok: true, title: site.title };
});

ipcMain.handle('auth:logout', async (_event, payload) => {
  const siteId = core.safeText(payload?.site, 24);
  const site = LOGIN_SITES[siteId];
  if (!site) return { ok: false, error: '未知站点。' };
  try {
    const cookies = await siteCookies(site);
    await Promise.all(cookies.filter((c) => core.isSiteCookie(c, site)).map((cookie) => {
      const scheme = cookie.secure ? 'https://' : 'http://';
      const domain = String(cookie.domain || '').replace(/^\./, '');
      return session.fromPartition(site.partition).cookies.remove(
        scheme + domain,
        cookie.name,
      ).catch(() => {});
    }));
  } catch {}
  core.removeExportedCookies(DATA_DIR(), siteId);
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return { ok: true, snapshot };
});

// 导出登录态给命令行用（agent 走这条路读同一份会话）。开关只影响导出文件。
ipcMain.handle('auth:export', async (_event, payload) => {
  const siteId = core.safeText(payload?.site, 24);
  const site = LOGIN_SITES[siteId];
  if (!site) return { ok: false, error: '未知站点。' };
  const enabled = payload?.enabled === true;
  if (!enabled) {
    core.removeExportedCookies(DATA_DIR(), siteId);
    const snapshot = await collectAuthSnapshot();
    sendToMain('auth:changed', snapshot);
    return { ok: true, exported: false };
  }
  const result = core.exportSiteCookies(DATA_DIR(), site, await siteCookies(site));
  if (!result.ok) return result;
  const snapshot = await collectAuthSnapshot();
  sendToMain('auth:changed', snapshot);
  return { ok: true, exported: true, path: result.path, cookie_count: result.cookie_count };
});

// ── 供应用内 HTTP 接口（127.0.0.1:8392）复用：提交队列并等它跑完 ────────────
const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled', 'paused']);

function downloadThroughQueue(payload) {
  const task = makeTask(payload || {});
  pumpQueue();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      emitQueue();
      if (!FINISHED_STATUSES.has(task.status)) return;
      clearInterval(poll);
      resolve({
        ok: task.status === 'done',
        cancelled: task.status === 'cancelled' || task.status === 'paused',
        error: task.error,
        task_id: task.id,
        data: { files: task.files, bytes: task.bytes, engine: task.used_engine },
      });
    }, 400);
    poll.unref?.();
  });
}

// ── 窗口控制（自绘标题栏）───────────────────────────────────────────────
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
ipcMain.handle('window:is-maximized', () => Boolean(mainWindow?.isMaximized()));

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

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.qingying.downloader');
    core.ensureDirSync(DATA_DIR());
    createWindow();
    await probeEngines();
    const snapshot = await collectAuthSnapshot();
    sendToMain('auth:changed', snapshot);
    emitEngines();
    // 默认下载目录：用户没设过就落到"下载"，避免第一次点下载卡在"请选择目录"。
    const settings = core.readSettings(DATA_DIR());
    if (!settings.outputDir) {
      core.writeSettings(DATA_DIR(), { outputDir: app.getPath('downloads') });
      emitQueue(true);
    }
    try {
      const apiPort = Number(process.env.QINGYING_API_PORT) || DEFAULT_API_PORT;
      const server = createAgentApiServer({
        analyzeMedia,
        downloadMedia: downloadThroughQueue,
        queueSnapshot,
        version: app.getVersion(),
      });
      server.on('error', () => {});
      server.listen(apiPort, '127.0.0.1', () => {
        console.log('[qingying-agent-api] listening on http://127.0.0.1:' + apiPort);
      });
    } catch (_) {}
  });
}

app.on('before-quit', () => {
  for (const id of taskOrder) {
    const task = tasks.get(id);
    if (task && task.status === 'downloading') stopTask(task, { pause: false });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
