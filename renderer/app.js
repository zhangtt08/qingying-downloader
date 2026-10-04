const elements = {
  appVersion: document.querySelector('#app-version'),
  url: document.querySelector('#url'),
  paste: document.querySelector('#paste'),
  analyze: document.querySelector('#analyze'),
  analyzeText: document.querySelector('#analyze-text'),
  status: document.querySelector('#status'),
  siteChip: document.querySelector('#site-chip'),
  loginChip: document.querySelector('#login-chip'),
  contextLogin: document.querySelector('#context-login'),
  batchToggle: document.querySelector('#batch-toggle'),
  batchPanel: document.querySelector('#batch-panel'),
  batchUrls: document.querySelector('#batch-urls'),
  batchCount: document.querySelector('#batch-count'),
  batchRun: document.querySelector('#batch-run'),

  emptyState: document.querySelector('#empty-state'),
  emptyTitle: document.querySelector('#empty-title'),
  emptyCopy: document.querySelector('#empty-copy'),
  errorCard: document.querySelector('#error-card'),
  errorSummary: document.querySelector('#error-summary'),
  errorDetail: document.querySelector('#error-detail'),
  errorKind: document.querySelector('#error-kind'),
  errorChainList: document.querySelector('#error-chain-list'),
  remedyList: document.querySelector('#remedy-list'),

  mediaCard: document.querySelector('#media-card'),
  thumbnail: document.querySelector('#thumbnail'),
  sourceHost: document.querySelector('#source-host'),
  uploader: document.querySelector('#uploader'),
  title: document.querySelector('#title'),
  meta: document.querySelector('#meta'),
  engineLine: document.querySelector('#engine-line'),
  engineChain: document.querySelector('#engine-chain'),
  engineChainList: document.querySelector('#engine-chain-list'),
  videoField: document.querySelector('#video-field'),
  audioField: document.querySelector('#audio-field'),
  audioOutputField: document.querySelector('#audio-output-field'),
  videoFormat: document.querySelector('#video-format'),
  audioFormat: document.querySelector('#audio-format'),
  audioOutput: document.querySelector('#audio-output'),
  selectionNote: document.querySelector('#selection-note'),
  filenamePreview: document.querySelector('#filename-preview'),
  download: document.querySelector('#download'),
  downloadText: document.querySelector('#download-text'),
  openFolder: document.querySelector('#open-folder'),

  queueSummary: document.querySelector('#queue-summary'),
  taskList: document.querySelector('#task-list'),
  taskEmpty: document.querySelector('#task-empty'),
  clearFinished: document.querySelector('#clear-finished'),
  tempRow: document.querySelector('#temp-row'),
  tempNote: document.querySelector('#temp-note'),
  tempClean: document.querySelector('#temp-clean'),
  settingConcurrency: document.querySelector('#setting-concurrency'),
  settingRetry: document.querySelector('#setting-retry'),
  settingEngine: document.querySelector('#setting-engine'),

  folder: document.querySelector('#folder'),
  chooseFolder: document.querySelector('#choose-folder'),
  template: document.querySelector('#template'),
  templateReset: document.querySelector('#template-reset'),
  templateError: document.querySelector('#template-error'),
  templateFieldHint: document.querySelector('#template-field-hint'),
  settingSubfolder: document.querySelector('#setting-subfolder'),
  settingExportCookies: document.querySelector('#setting-export-cookies'),
  dataDirNote: document.querySelector('#data-dir-note'),

  authList: document.querySelector('#auth-list'),
  authStorageNote: document.querySelector('#auth-storage-note'),
  refreshAuth: document.querySelector('#refresh-auth'),

  historyList: document.querySelector('#history-list'),
  historySummary: document.querySelector('#history-summary'),
  historyEmpty: document.querySelector('#history-empty'),
  clearHistory: document.querySelector('#clear-history'),

  engineList: document.querySelector('#engine-list'),
  engineNote: document.querySelector('#engine-note'),
  engineDirNote: document.querySelector('#engine-dir-note'),
  chooseEnginesDir: document.querySelector('#choose-engines-dir'),
  probeEngines: document.querySelector('#probe-engines'),

  stepAnalyze: document.querySelector('#step-analyze'),
  stepFormat: document.querySelector('#step-format'),
  stepSave: document.querySelector('#step-save'),
};

const MODES = ['combined', 'video', 'audio', 'images'];
const HISTORY_RENDER_LIMIT = 30;
let defaultTemplate = '%(title).180B [%(id)s].%(ext)s';
let mode = 'combined';
let media = null;
let analyzing = false;
let settings = null;
let queue = { tasks: [], running: 0, limit: 2 };
let auth = null;
let engines = null;
let history = [];
let contextSiteId = '';
let lastFinishedKey = '__none__';

// ── 基础状态 ──────────────────────────────────────────────────────────────
function setStatus(message, type = '') {
  elements.status.textContent = message;
  elements.status.className = `status ${type}`.trim();
}

function setWorkflow(step, state = 'current') {
  const steps = [elements.stepAnalyze, elements.stepFormat, elements.stepSave];
  steps.forEach((element, index) => {
    const position = index + 1;
    const next = position < step ? 'complete' : position === step ? state : 'pending';
    element.dataset.state = next;
    element.classList.toggle('active', next === 'current');
  });
}

function setEmptyState(state, title, copy) {
  elements.emptyState.dataset.state = state;
  elements.emptyTitle.textContent = title;
  elements.emptyCopy.textContent = copy;
  elements.emptyState.classList.remove('hidden');
}

function hideMediaResult() {
  media = null;
  elements.mediaCard.classList.add('hidden');
  elements.errorCard.classList.add('hidden');
  setWorkflow(1);
}

function formatDuration(seconds) {
  if (!seconds) return '时长未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return [h, m, s].filter((_, index) => h > 0 || index > 0).map((v) => String(v).padStart(2, '0')).join(':');
}

function videoLabel(item) {
  return [
    item.resolution,
    item.fps ? `${Math.round(item.fps)} FPS` : '',
    item.ext.toUpperCase(),
    item.codec,
    item.hasAudio ? '自带音频' : '纯视频',
    item.size,
  ].filter(Boolean).join(' · ');
}

function audioLabel(item) {
  return [
    item.abr ? `${Math.round(item.abr)} kbps` : '码率未知',
    item.ext.toUpperCase(),
    item.codec,
    item.language,
    item.size,
  ].filter(Boolean).join(' · ');
}

function safeHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function make(text, tag = 'span') {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

// 主进程没给 size 时的兜底换算（界面永远显示真实字节数换算出来的大小，不显示猜测值）。
function humanBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 || size >= 100 ? 0 : 1)} ${units[unit]}`;
}

function makeButton(text, className, onClick, disabled) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = text;
  node.disabled = Boolean(disabled);
  node.addEventListener('click', onClick);
  return node;
}

// ── 引擎面板：本机到底有没有能力，说清楚 ──────────────────────────────────
const ENGINE_LABELS = {
  'yt-dlp': 'yt-dlp（视频/音频）',
  'gallery-dl': 'gallery-dl（图集）',
  ffmpeg: 'ffmpeg（合并与转码）',
};
const ENGINE_KEYS = { 'yt-dlp': 'yt_dlp', 'gallery-dl': 'gallery_dl', ffmpeg: 'ffmpeg' };

function renderEngines() {
  elements.engineList.replaceChildren();
  if (!engines) {
    elements.engineList.append(make('正在探测本机引擎…', 'li'));
    return;
  }
  for (const [name, label] of Object.entries(ENGINE_LABELS)) {
    const record = engines[ENGINE_KEYS[name]];
    const row = document.createElement('li');
    row.className = `engine-row ${record?.available ? 'ok' : 'missing'}`;
    const dot = make('', 'i');
    const body = document.createElement('div');
    body.append(make(label, 'strong'));
    const detail = record?.available
      ? `v${record.version} · ${sourceLabel(record.source)}`
      : `未安装 · ${record?.error || '不可用'}`;
    body.append(make(detail, 'small'));
    row.append(dot, body);
    elements.engineList.append(row);
  }
  const galleryMissing = !engines['gallery_dl']?.available;
  const ffmpegMissing = !engines['ffmpeg']?.available;
  const notes = [];
  if (!engines['yt_dlp']?.available) notes.push('没有 yt-dlp 就无法下载视频：装一份，或点下面"指定引擎目录"指到它所在的文件夹（安装包里的 resources/bin）后重新探测。');
  if (galleryMissing) notes.push('没有 gallery-dl：图集会改用内置取图器逐张保存，Instagram/小红书可能因此受限。');
  if (ffmpegMissing) notes.push('没有 ffmpeg：视频与音频分开的轨道无法合并，请改选"自带音频"的画质或只下载视频。');
  elements.engineNote.textContent = notes.join(' ');
  const dirStatus = engines.engines_dir;
  elements.engineDirNote.textContent = dirStatus
    ? (dirStatus.configured
      ? (dirStatus.exists ? `引擎目录：${dirStatus.path}` : `引擎目录已失效：${dirStatus.path}`)
      : '未指定引擎目录（按环境变量与 PATH 查找）')
    : '';
  elements.engineDirNote.classList.toggle('warn', Boolean(dirStatus && dirStatus.configured && !dirStatus.exists));
}

function sourceLabel(source) {
  return {
    override: '应用内置',
    env: '环境变量指定',
    bundled: '指定目录',
    PATH: '系统 PATH',
    not_found: '未找到',
  }[source] || source;
}

// ── 登录态面板 ────────────────────────────────────────────────────────────
// 站点表（名称、域名、内容形态）只有一个来源：主进程里的 engine-core。
// 界面自己抄一份域名就会分叉 —— 这里不再保留第二份。
let siteCatalog = [];
let siteLabels = {};
let sitesLoaded = false;

function applySiteCatalog(list) {
  siteCatalog = Array.isArray(list) ? list : [];
  siteLabels = {};
  for (const site of siteCatalog) siteLabels[site.id] = site.label;
  sitesLoaded = true;
  renderAuth();
  updateContextChips();
}

function siteOf(url) {
  if (!url) return null;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return siteCatalog.find((site) => (site.domains || []).some(
    (domain) => host === domain || host.endsWith('.' + domain),
  )) || null;
}

function renderAuth() {
  elements.authList.replaceChildren();
  if (!siteCatalog.length) {
    elements.authList.append(make(sitesLoaded ? '没有读到站点表，重新打开窗口可恢复。' : '正在读取站点表…', 'li'));
    return;
  }
  if (!auth) {
    elements.authList.append(make('正在检测登录态…', 'li'));
    return;
  }
  const sites = auth.sites || {};
  const ids = siteCatalog.map((site) => site.id);
  // 当前链接涉及的站点排最前，用户不必翻找。
  ids.sort((a, b) => (b === contextSiteId ? 1 : 0) - (a === contextSiteId ? 1 : 0));
  for (const siteId of ids) {
    const meta = siteCatalog.find((site) => site.id === siteId) || {};
    const record = sites[siteId] || {};
    const row = document.createElement('li');
    row.className = 'auth-row';
    if (siteId === contextSiteId) row.classList.add('is-context');

    const dot = make('', 'i');
    const state = record.logged_in ? 'in' : (record.expired_detected ? 'expired' : 'out');
    dot.className = `dot ${state}`;

    const body = document.createElement('div');
    body.className = 'auth-body';
    const title = document.createElement('strong');
    title.textContent = meta.label || siteId;
    if (record.login_required) {
      const tag = make('必须登录', 'em');
      tag.className = 'tag-required';
      title.append(' ', tag);
    }
    body.append(title);
    const detail = document.createElement('small');
    if (record.logged_in) {
      const judged = (record.matched_cookie_names || []).join(' / ') || '会话标记';
      detail.textContent = record.expires_at
        ? `已登录 · 依据 ${judged} · ${formatExpiry(record.expires_at)} 过期`
        : `已登录 · 依据 ${judged} · 会话型 Cookie（关掉即失效）`;
    } else if (record.expired_detected) {
      detail.textContent = '登录已过期，请点"登录"重新完成一次。';
    } else {
      detail.textContent = record.has_partition
        ? '没有检测到有效登录 Cookie。'
        : '从未在这个应用里登录过。';
    }
    body.append(detail);
    const kind = document.createElement('small');
    kind.className = 'auth-kind';
    kind.textContent = (meta.content_kind === 'images' ? '图集为主' : '视频为主')
      + (record.exported ? ' · 已导出给命令行' : '');
    body.append(kind);

    const actions = document.createElement('div');
    actions.className = 'auth-actions';
    actions.append(makeButton(record.logged_in ? '重新登录' : '登录', 'mini-button', () => openLogin(siteId)));
    if (record.logged_in) {
      actions.append(makeButton('退出登录', 'mini-button ghost', () => logoutSite(siteId)));
    }
    const exported = Boolean(record.exported);
    actions.append(makeButton(exported ? '已导出给命令行' : '导出给命令行', `mini-button ghost${exported ? ' on' : ''}`, () => exportSite(siteId, !exported)));
    body.append(actions);

    row.append(dot, body);
    elements.authList.append(row);
  }

  const storage = auth.storage;
  if (storage) {
    const exportedList = (storage.exported || []).map((id) => siteLabels[id] || id);
    elements.authStorageNote.textContent = [
      `会话存放：${storage.session_dir}（每站点一个独立分区，仅当前 Windows 账户可读）。`,
      `导出文件：${storage.cookie_dir}（写出时按 0600 请求；${exportedList.length ? `当前已导出：${exportedList.join('、')}` : '当前没有导出任何 Cookie 文件'}）。`,
      '本应用不读取、不显示、不记录任何 Cookie 值。',
    ].join(' ');
  }
}

function formatExpiry(iso) {
  try {
    const date = new Date(iso);
    const days = Math.round((date - Date.now()) / 86400000);
    const stamp = date.toLocaleString('zh-CN', { hour12: false });
    return days > 0 ? `${stamp}（约 ${days} 天后）` : stamp;
  } catch {
    return iso;
  }
}

async function openLogin(siteId) {
  setStatus(`请在弹出的 ${(siteLabels[siteId] || siteId)} 窗口中登录，关闭该窗口后这里会自动检测。`);
  try {
    await window.qingying.openLogin(siteId);
  } catch {
    setStatus(`无法打开 ${(siteLabels[siteId] || siteId)} 登录窗口。`, 'error');
  }
}

async function logoutSite(siteId) {
  try {
    await window.qingying.logoutSite(siteId);
    await refreshAuth();
    setStatus(`${siteLabels[siteId] || siteId} 已退出登录（本机会话已清除）。`, 'success');
  } catch {
    setStatus('退出登录失败。', 'error');
  }
}

async function exportSite(siteId, enabled) {
  try {
    const result = await window.qingying.exportSiteCookies(siteId, enabled);
    if (!result?.ok) {
      setStatus(result?.error || '导出失败。', 'error');
    } else if (result.exported) {
      setStatus(`已导出 ${siteLabels[siteId] || siteId} 登录态给命令行接口，文件在本机数据目录里（随时可撤销）。`, 'success');
    } else {
      setStatus(`已撤销 ${siteLabels[siteId] || siteId} 的命令行导出，本机文件已删除。`, 'success');
    }
    await refreshAuth();
  } catch {
    setStatus('导出登录态失败。', 'error');
  }
}

async function refreshAuth() {
  try {
    auth = await window.qingying.authStatus();
    renderAuth();
    updateContextChips();
  } catch {
    setStatus('无法读取登录态。', 'error');
  }
}

// ── 输入框下方的上下文条：这条链接归谁、要不要登录、走哪条链路 ─────────────
function updateContextChips() {
  const url = elements.url.value.trim();
  contextSiteId = '';
  elements.siteChip.classList.add('hidden');
  elements.loginChip.classList.add('hidden');
  elements.contextLogin.classList.add('hidden');

  const site = siteOf(url);
  if (!site) return;
  contextSiteId = site.id;

  const record = auth?.sites?.[site.id] || {};
  elements.siteChip.textContent = `${site.label} · ${site.content_kind === 'images' ? '图集为主' : '视频为主'}`;
  elements.siteChip.classList.remove('hidden');
  elements.loginChip.textContent = record.logged_in ? '已登录' : (site.login_required ? '必须登录' : '未登录（可匿名试）');
  elements.loginChip.className = `chip ${record.logged_in ? 'ok' : (site.login_required ? 'warn' : '')}`;
  elements.loginChip.classList.remove('hidden');
  const loginButton = elements.contextLogin;
  loginButton.textContent = record.logged_in ? '重新登录该站点' : '登录该站点';
  loginButton.classList.remove('hidden');
  if (media) renderAuth();
}

// ── 解析 ──────────────────────────────────────────────────────────────────
function setAnalyzeBusy(busy) {
  analyzing = busy;
  elements.analyze.disabled = busy;
  elements.paste.disabled = busy;
  elements.analyze.dataset.busy = String(busy);
  elements.analyzeText.textContent = busy ? '正在解析' : '解析链接';
}

const KIND_LABELS = {
  bad_url: '链接格式不对',
  bad_input: '任务参数不完整',
  engine_missing: '引擎未安装',
  login_required: '需要登录',
  needs_login: '可能需要登录',
  site_changed: '站点改版（本机引擎版本落后）',
  unsupported_site: '这条链接该站点不支持',
  unsupported_url: '这不是具体内容页',
  no_formats: '两个引擎都没有可下载内容',
  link_gone: '内容已失效或被删除',
  network: '网络不通',
  proxy: '被代理或证书拦下',
  rate_limited: '站点在限流',
  ipc_failed: '界面与主进程通信中断',
  unknown: '原因未归类（原始输出见下）',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] || kind || '未知';
}

const OUTCOME_LABELS = {
  ok: '成功',
  no_result: '没有返回内容',
  no_formats: '没有可用格式（说明该走另一个引擎）',
  failed: '报错',
};

// 引擎判定过程：谁先上、为什么、备胎有没有试过 —— 降级永远是看得见的。
function renderChainList(container, steps) {
  container.replaceChildren();
  for (const step of (Array.isArray(steps) ? steps : [])) {
    const item = document.createElement('li');
    item.className = `chain-step outcome-${step.outcome || (step.available === false ? 'unavailable' : 'planned')}`;
    const head = document.createElement('strong');
    head.textContent = step.engine
      + (step.role === 'fallback' ? '（备胎）' : step.role === 'primary' ? '（首选）' : '')
      + (step.outcome ? ` —— ${OUTCOME_LABELS[step.outcome] || step.outcome}` : (step.available === false ? ' —— 本机没有这个引擎，跳过' : ' —— 计划中'));
    item.append(head);
    if (step.detail) item.append(make(step.detail, 'small'));
    else if (step.reason) item.append(make(step.reason, 'small'));
    if (step.ms) item.append(make(`用时 ${(step.ms / 1000).toFixed(1)} 秒`, 'small'));
    container.append(item);
  }
  if (!container.children.length) {
    container.append(make('还没有任何引擎尝试记录。', 'li'));
  }
}

function showParseError(result) {
  media = null;
  elements.mediaCard.classList.add('hidden');
  elements.emptyState.classList.add('hidden');
  elements.errorCard.classList.remove('hidden');
  elements.errorSummary.textContent = result.error || '解析失败。';
  elements.errorKind.textContent = `原因：${kindLabel(result.kind)}｜链接：${elements.url.value.trim()}`;
  renderChainList(elements.errorChainList, result.engine_plan && !result.engine_attempts?.length
    ? result.engine_plan
    : (result.engine_attempts || []));
  const detailSteps = (result.engine_plan || []).map((step) => `计划 ${step.engine}（${step.role || ''}）：${step.reason}${step.unavailable ? ' [本机不可用]' : ''}`);
  const detailAttempts = (result.engine_attempts || []).map((step) => `尝试 ${step.engine} → ${step.outcome}（${step.ms || 0}ms）${step.detail ? '：' + step.detail : ''}`);
  elements.errorDetail.textContent = [
    `原因分类：${result.kind || 'unknown'}（${kindLabel(result.kind)}）`,
    ...detailSteps,
    ...detailAttempts,
    `链接：${elements.url.value.trim()}`,
  ].join('\n');
  elements.remedyList.replaceChildren();
  for (const remedy of result.remedies || []) {
    const item = document.createElement('li');
    item.append(makeButton(REMEDY_LABELS[remedy.action] || remedy.label, 'remedy-button', () => runRemedy(remedy, result)));
    if (remedy.detail) item.append(make(remedy.detail, 'small'));
    elements.remedyList.append(item);
  }
  if (!(result.remedies || []).length) {
    elements.remedyList.append(make('没有更多可自动执行的动作，请把上面的原始输出复制给开发者。', 'li'));
  }
  setWorkflow(1, 'current');
  setStatus(`解析没有成功（${kindLabel(result.kind)}），下面给出可以点下一步的动作。`, 'error');
}

const REMEDY_LABELS = {
  login: '打开登录窗口',
  open_site: '在浏览器打开这条链接',
  retry: '重试解析',
  wait_retry: '等 20 秒后重试',
  other_engine: '改用另一个引擎重试',
  copy_diagnostics: '复制诊断信息',
  install_engine: '查看引擎状态并重新探测',
  check_network: '检查网络/代理后重试',
  fix_url: '回到输入框改链接',
  update_engine: '看引擎版本并考虑升级',
  check_page_type: '回到输入框换一条内容页链接',
  copy_link: '回到输入框换一条链接',
};

function runRemedy(remedy, result) {
  switch (remedy.action) {
    case 'login':
      openLogin(contextSiteId || siteOf(elements.url.value.trim())?.id || '');
      break;
    case 'open_site':
      void window.qingying.openExternal(elements.url.value.trim());
      break;
    case 'retry':
    case 'check_network':
      void analyze();
      break;
    case 'wait_retry':
      setStatus('等待 20 秒后自动重试（站点在限流，连打只会延长被限流时间）。');
      setTimeout(() => analyze(), 20000);
      break;
    case 'other_engine':
      void analyze(result?.forcePreference || otherEnginePreference());
      break;
    case 'copy_diagnostics':
      void window.qingying.writeClipboard(elements.errorDetail.textContent || '');
      setStatus('诊断信息已复制到剪贴板。', 'success');
      break;
    case 'install_engine':
      void probeEngines().then(() => elements.engineList.scrollIntoView({ behavior: 'smooth', block: 'center' }));
      break;
    case 'update_engine':
      void probeEngines().then(() => {
        elements.engineList.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setStatus('已列出本机引擎版本。站点改版时先升级 yt-dlp / gallery-dl（例如 yt-dlp -U），再点"重新探测"。');
      });
      break;
    case 'check_page_type':
    case 'copy_link':
    case 'fix_url':
      elements.url.focus();
      elements.url.select();
      setStatus('请把链接换成打开某一条具体内容后复制到的地址。');
      break;
    default:
      void analyze();
  }
}

function otherEnginePreference() {
  const current = settings?.enginePreference || 'auto';
  if (current !== 'auto') return 'auto';
  return engines?.gallery_dl?.available ? 'gallery-dl' : 'yt-dlp';
}

async function analyze(preferenceOverride) {
  if (analyzing) return { ok: false };
  const url = elements.url.value.trim();
  if (!url) {
    elements.url.focus();
    setStatus('请先粘贴链接。', 'error');
    return { ok: false };
  }

  hideMediaResult();
  setAnalyzeBusy(true);
  setEmptyState('loading', '正在读取可用格式', '引擎判定和抓取都在本机进行，请保持窗口开启。');
  setStatus('正在解析…');
  updateContextChips();

  let result;
  try {
    result = await window.qingying.analyze(url, preferenceOverride || '');
  } catch (error) {
    result = { ok: false, error: error?.message || '解析过程意外中断。', kind: 'ipc_failed', remedies: [{ action: 'retry', label: '重试解析' }] };
  } finally {
    setAnalyzeBusy(false);
  }

  if (!result?.ok) {
    showParseError(result || { error: '解析失败。', remedies: [] });
    return { ok: false };
  }

  media = result.data;
  if (media.sessionId) contextSiteId = media.sessionId;
  renderMedia();
  updateContextChips();
  setStatus('解析完成，可以选择格式和保存位置。', 'success');
  return { ok: true, data: media };
}

function renderMedia() {
  const imageCount = Array.isArray(media.images) ? media.images.length : 0;
  const imagesOnly = imageCount > 0 && !media.videos.length && !media.audios.length;

  elements.thumbnail.src = media.thumbnail || '';
  elements.thumbnail.alt = media.thumbnail ? `${media.title} 的缩略图` : '';
  elements.thumbnail.classList.toggle('hidden', !media.thumbnail);
  elements.sourceHost.textContent = safeHost(media.webpageUrl);
  elements.sourceHost.classList.toggle('hidden', !elements.sourceHost.textContent);
  elements.uploader.textContent = media.uploader || media.siteLabel || '作品信息';
  elements.title.textContent = media.title;
  elements.meta.textContent = imagesOnly
    ? `${imageCount} 张图片 · 可直接保存原图`
    : `${formatDuration(media.duration)} · ${media.videos.length} 个视频格式 · ${media.audios.length} 个音频格式`;
  const versionSuffix = media.engine_version ? ` · 版本 ${media.engine_version}` : '';
  elements.engineLine.textContent = `引擎：${media.engine}${versionSuffix} —— ${media.engine_reason || ''}`;
  const chainSteps = (media.engine_chain && media.engine_chain.length)
    ? media.engine_chain
    : (media.engine_plan || []);
  elements.engineChain.classList.toggle('hidden', !chainSteps.length);
  renderChainList(elements.engineChainList, chainSteps);

  const tabs = document.querySelector('.mode-tabs');
  if (imagesOnly) {
    tabs.classList.add('hidden');
    document.querySelector('#format-panel').classList.add('hidden');
    mode = 'images';
    elements.selectionNote.textContent = `共 ${imageCount} 张图片，按顺序保存原图，不需要选格式。`;
    elements.downloadText.textContent = '下载全部图片';
  } else {
    tabs.classList.remove('hidden');
    document.querySelector('#format-panel').classList.remove('hidden');
    populateSelect(elements.videoFormat, media.videos, videoLabel, '没有独立视频格式');
    populateSelect(elements.audioFormat, media.audios, audioLabel, '没有独立音频格式');
    const audioTab = document.querySelector('.mode[data-mode="audio"]');
    const combinedTab = document.querySelector('.mode[data-mode="combined"]');
    const videoTab = document.querySelector('.mode[data-mode="video"]');
    audioTab.disabled = media.audios.length === 0;
    videoTab.disabled = media.videos.length === 0;
    combinedTab.disabled = media.videos.length === 0;
    audioTab.title = media.audios.length === 0 ? '该链接没有独立音轨' : '';
    if (!media.videos.length) setMode('audio');
    else if (mode === 'audio' && !media.audios.length) setMode('combined');
    else if (mode === 'images') setMode('combined');
    chooseCompatibleAudio();
    syncFormatState();
  }

  elements.emptyState.classList.add('hidden');
  elements.errorCard.classList.add('hidden');
  elements.mediaCard.classList.remove('hidden');
  setWorkflow(2);
  refreshFilenamePreview();
}

function populateSelect(select, items, labeler, emptyText) {
  select.replaceChildren();
  if (!items.length) {
    const option = new Option(emptyText, '');
    option.disabled = true;
    option.selected = true;
    select.add(option);
    return;
  }
  items.forEach((item) => select.add(new Option(labeler(item), item.id)));
}

function selectedVideo() {
  return media?.videos.find((item) => item.id === elements.videoFormat.value) || null;
}

function selectedAudio() {
  return media?.audios.find((item) => item.id === elements.audioFormat.value) || null;
}

function chooseCompatibleAudio() {
  const video = selectedVideo();
  if (!video || video.hasAudio || !media?.audios.length) return;
  const preferred = video.ext === 'mp4'
    ? media.audios.find((item) => ['m4a', 'mp4', 'aac'].includes(item.ext.toLowerCase()))
    : null;
  if (preferred) elements.audioFormat.value = preferred.id;
}

function syncFormatState() {
  const video = selectedVideo();
  const audio = selectedAudio();
  const videoHasAudio = Boolean(video?.hasAudio);

  elements.videoField.classList.toggle('hidden', mode === 'audio' || mode === 'images');
  elements.audioField.classList.toggle('hidden', mode === 'video' || mode === 'images' || (mode === 'combined' && videoHasAudio));
  elements.audioOutputField.classList.toggle('hidden', mode !== 'audio');

  const ffmpegMissing = engines && !engines.ffmpeg?.available;
  if (mode === 'combined') {
    elements.downloadText.textContent = '下载视频与音频';
    if (videoHasAudio) {
      elements.selectionNote.textContent = '所选画质自带音轨，直接保存源格式，不会重复合并。';
    } else if (video && audio) {
      const mp4Compatible = video.ext.toLowerCase() === 'mp4' && ['m4a', 'mp4', 'aac'].includes(audio.ext.toLowerCase());
      elements.selectionNote.textContent = (mp4Compatible
        ? '视频与音频合并为 MP4。'
        : '当前编码组合合并为 MKV，避免转码损失。') + (ffmpegMissing ? ' 但本机没有 ffmpeg，合并会失败，请改选"自带音频"的画质。' : '');
    } else {
      elements.selectionNote.textContent = '请选择可用的视频与音频格式。';
    }
  } else if (mode === 'video') {
    elements.downloadText.textContent = '仅下载视频';
    elements.selectionNote.textContent = videoHasAudio
      ? '该源格式自带音轨，保存后仍会有声音。'
      : '只保存视频轨道，不合并音频。';
  } else if (mode === 'audio') {
    elements.downloadText.textContent = '仅下载音频';
    elements.selectionNote.textContent = `音频转换为 ${elements.audioOutput.value.toUpperCase()}。`
      + (ffmpegMissing ? ' 需要 ffmpeg 转码，本机未检测到。' : '');
  } else {
    elements.downloadText.textContent = '下载全部图片';
  }
  refreshFilenamePreview();
}

function setMode(nextMode) {
  if (!MODES.includes(nextMode)) return;
  mode = nextMode;
  document.querySelectorAll('.mode').forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  syncFormatState();
}

function refreshFilenamePreview() {
  if (!media || !settings) {
    elements.filenamePreview.textContent = '';
    return;
  }
  const video = selectedVideo();
  const audio = selectedAudio();
  const ext = mode === 'audio'
    ? elements.audioOutput.value
    : (video?.ext || audio?.ext || 'mp4');
  void window.qingying.previewTemplate(settings.filenameTemplate, {
    title: media.title,
    id: '',
    ext,
    uploader: media.uploader,
  }).then((result) => {
    if (!result?.ok) {
      elements.filenamePreview.textContent = `命名模板有问题：${result?.error || '未知原因'}`;
      return;
    }
    const dir = elements.folder.value.trim() || '(未选择目录)';
    elements.filenamePreview.textContent = `保存为：${dir}\\${result.preview}`;
  }).catch(() => {
    elements.filenamePreview.textContent = '';
  });
}

// ── 队列 ──────────────────────────────────────────────────────────────────
function buildQueueItem() {
  const video = selectedVideo();
  const audio = selectedAudio();
  const imagesOnly = mode === 'images';
  return {
    url: media.webpageUrl,
    title: media.title,
    mode: imagesOnly ? 'images' : mode,
    videoId: video?.id || '',
    videoExt: video?.ext || '',
    videoHasAudio: Boolean(video?.hasAudio),
    audioId: audio?.id || '',
    audioExt: audio?.ext || '',
    audioFormat: elements.audioOutput.value,
    images: imagesOnly ? media.images : [],
    site: media.sessionId || '',
    engine: media.engine || '',
    outputDir: elements.folder.value.trim(),
  };
}

async function enqueueCurrent() {
  if (!media) return setStatus('请先解析链接。', 'error');
  if (!elements.folder.value.trim()) return setStatus('请选择下载目录。', 'error');
  const video = selectedVideo();
  const audio = selectedAudio();
  if (mode !== 'images' && mode !== 'audio' && !video) return setStatus('请选择视频画质。', 'error');
  if (mode === 'audio' && !audio) return setStatus('请选择音频轨道。', 'error');
  if (mode === 'combined' && !video?.hasAudio && !audio) return setStatus('请选择用于合并的音频轨道。', 'error');

  const result = await window.qingying.submitQueue([buildQueueItem()]);
  if (!result?.ok) {
    setStatus(result?.error || '加入队列失败。', 'error');
    return;
  }
  setWorkflow(3);
  setStatus(`已加入队列，共 ${result.tasks.length} 个任务。`, 'success');
}

function renderQueue(snapshot) {
  if (snapshot) queue = snapshot;
  const tasks = queue.tasks || [];
  const active = tasks.filter((task) => ['queued', 'downloading'].includes(task.status));
  elements.queueSummary.textContent = tasks.length
    ? `进行中 ${active.length} · 并发上限 ${queue.limit} · 共 ${tasks.length} 条`
    : '没有任务';
  elements.taskEmpty.classList.toggle('hidden', tasks.length > 0);
  elements.taskList.replaceChildren();

  for (const task of [...tasks].reverse()) {
    const item = document.createElement('li');
    item.className = `task-row status-${task.status}`;

    const head = document.createElement('div');
    head.className = 'task-head';
    head.append(make(task.title, 'strong'));
    const retryText = task.retrying ? ' · 等重试倒计时' : task.attempts > 1 ? ` · 第 ${task.attempts} 次尝试` : '';
    head.append(make(`${STATUS_LABELS[task.status] || task.status}${task.used_engine ? ` · ${task.used_engine}` : ''}${retryText}`, 'span'));
    item.append(head);

    const meta = document.createElement('p');
    meta.className = 'task-meta';
    const pieces = [
      safeHost(task.url) || '链接',
      task.mode,
      task.file_count ? `${task.file_count} 个文件` : '',
      task.size_text && task.bytes ? task.size_text : '',
      task.progress?.percent ? `${task.progress.percent}` : '',
      task.progress?.speed || '',
      task.progress?.eta || '',
    ].filter(Boolean);
    meta.textContent = pieces.join(' · ');
    item.append(meta);

    const percent = Number.parseFloat(task.progress?.percent) || (task.status === 'done' ? 100 : 0);
    const track = document.createElement('div');
    track.className = 'task-track';
    const bar = document.createElement('div');
    bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    track.append(bar);
    if (task.status === 'downloading' || task.status === 'done') item.append(track);

    if (task.error) {
      const error = document.createElement('p');
      error.className = 'task-error';
      error.textContent = `${task.error}${task.kind ? `（${kindLabel(task.kind)}）` : ''}`;
      item.append(error);
      for (const remedy of (task.remedies || []).slice(0, 4)) {
        const button = makeButton(REMEDY_LABELS[remedy.action] || remedy.label, 'remedy-button', () => {
          if (remedy.action === 'login' || remedy.action === 'open_site') {
            elements.url.value = task.url || '';
            updateContextChips();
          }
          if (remedy.action === 'retry') {
            void window.qingying.retryTask(task.id);
            return;
          }
          runRemedy(remedy, null);
        });
        item.append(button);
        if (remedy.detail) item.append(make(remedy.detail, 'task-remedy-detail'));
      }
    }

    if (task.status === 'paused' || task.status === 'cancelled') {
      const hint = document.createElement('p');
      hint.className = 'task-meta';
      hint.textContent = '已下载的分片保留在目标目录里（.part / .ytdl），点"重试/继续"会接着下，不会从头重来。';
      item.append(hint);
    }

    if (task.status === 'done' && task.files?.length) {
      const list = document.createElement('div');
      list.className = 'task-files';
      for (const file of task.files.slice(0, 3)) {
        const name = String(file.path).split(/[\\/]/).pop();
        const size = file.size || humanBytes(file.bytes);
        const button = makeButton(`${name}${size ? ` (${size})` : ''}`, 'mini-button ghost', () => {
          void window.qingying.revealFile(file.path);
        });
        button.title = file.path;
        list.append(button);
      }
      if (task.file_count > 3) list.append(make(`还有 ${task.file_count - 3} 个文件`, 'small'));
      item.append(list);
    }

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (task.status === 'downloading' || task.status === 'queued') {
      actions.append(makeButton('暂停', 'mini-button', () => window.qingying.pauseTask(task.id)));
      actions.append(makeButton('取消', 'mini-button ghost', () => window.qingying.cancelTask(task.id)));
    } else if (task.status === 'paused') {
      actions.append(makeButton('继续', 'mini-button', () => window.qingying.resumeTask(task.id)));
    } else if (task.status === 'failed' || task.status === 'cancelled') {
      actions.append(makeButton('重试', 'mini-button', () => window.qingying.retryTask(task.id)));
    }
    if (task.output_dir) {
      actions.append(makeButton('打开目录', 'mini-button ghost', () => window.qingying.openFolder(task.output_dir)));
    }
    if (task.status === 'done' && task.file_count) {
      actions.append(makeButton('删除记录', 'mini-button ghost', () => window.qingying.removeTask(task.id)));
    }
    item.append(actions);
    elements.taskList.append(item);
  }

  // 有任务进入终态就去清点一次残留分片（不在每次进度回调里扫盘）。
  const finishedKey = tasks
    .filter((task) => ['done', 'failed', 'cancelled', 'paused'].includes(task.status))
    .map((task) => `${task.id}:${task.status}`)
    .join(',');
  if (finishedKey !== lastFinishedKey) {
    lastFinishedKey = finishedKey;
    scheduleTempScan();
  }
}

let tempScanTimer = null;
function scheduleTempScan() {
  clearTimeout(tempScanTimer);
  tempScanTimer = setTimeout(() => void refreshTempFiles(), 700);
}

async function refreshTempFiles() {
  const folder = elements.folder.value.trim();
  if (!folder) {
    elements.tempRow.classList.add('hidden');
    return;
  }
  try {
    const scan = await window.qingying.scanTempFiles(folder);
    if (!scan?.valid || !scan.count) {
      elements.tempRow.classList.add('hidden');
      return;
    }
    elements.tempNote.textContent = `下载目录里有 ${scan.count} 个未完成的分片（共 ${scan.size_text || humanBytes(scan.bytes)}），`
      + `最早的是 ${formatTime(scan.oldest)}。暂停/重试会接着用它们；确认不要了可以清掉，成品文件不受影响。`;
    elements.tempRow.classList.remove('hidden');
  } catch {
    elements.tempRow.classList.add('hidden');
  }
}

const STATUS_LABELS = {
  queued: '排队中',
  downloading: '下载中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

// ── 历史 ──────────────────────────────────────────────────────────────────
function renderHistory(items) {
  if (items) history = items;
  const list = history || [];
  const done = list.filter((item) => item.status === 'done').length;
  const failed = list.filter((item) => item.status === 'failed').length;
  const shown = Math.min(list.length, HISTORY_RENDER_LIMIT);
  elements.historySummary.textContent = list.length
    ? `共 ${list.length} 条 · 成功 ${done} · 失败 ${failed} · 这里列出最近 ${shown} 条`
    : '还没有记录';
  elements.historyEmpty.classList.toggle('hidden', list.length > 0);
  elements.historyList.replaceChildren();

  for (const item of list.slice(0, HISTORY_RENDER_LIMIT)) {
    const row = document.createElement('li');
    row.className = `history-row status-${item.status}`;
    const body = document.createElement('div');
    body.append(make(item.title || safeHost(item.url) || '未命名', 'strong'));
    const detail = document.createElement('small');
    const bytesText = item.bytes ? humanBytes(item.bytes) : '';
    detail.textContent = [
      STATUS_LABELS[item.status] || item.status,
      item.engine,
      bytesText,
      Array.isArray(item.files) && item.files.length ? `${item.files.length} 个文件` : '',
      formatTime(item.finished_at),
      item.error ? `失败：${item.error}` : '',
    ].filter(Boolean).join(' · ');
    body.append(detail);
    row.append(body);

    const actions = document.createElement('div');
    actions.className = 'task-actions';
    if (item.output_dir) actions.append(makeButton('打开目录', 'mini-button ghost', () => window.qingying.openFolder(item.output_dir)));
    actions.append(makeButton('复制链接', 'mini-button ghost', () => {
      void window.qingying.writeClipboard(item.url || '');
      setStatus('链接已复制。', 'success');
    }));
    actions.append(makeButton('再下一次', 'mini-button', () => {
      elements.url.value = item.url || '';
      hideMediaResult();
      void analyze();
    }));
    row.append(actions);
    elements.historyList.append(row);
  }
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const ageMinutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (ageMinutes < 1) return '刚刚';
  if (ageMinutes < 60) return `${ageMinutes} 分钟前`;
  if (ageMinutes < 60 * 24) return `${Math.round(ageMinutes / 60)} 小时前`;
  return date.toLocaleDateString('zh-CN');
}

// ── 设置 ──────────────────────────────────────────────────────────────────
function applySettings(next) {
  if (!next) return;
  settings = next;
  if (elements.folder.value !== next.outputDir && document.activeElement !== elements.folder) {
    elements.folder.value = next.outputDir || '';
  }
  if (document.activeElement !== elements.template) elements.template.value = next.filenameTemplate || '';
  elements.settingConcurrency.value = String(next.concurrency ?? 2);
  elements.settingRetry.value = String(next.autoRetry ?? 2);
  elements.settingEngine.value = next.enginePreference || 'auto';
  elements.settingSubfolder.checked = Boolean(next.subfolderByPost);
  elements.settingExportCookies.checked = Boolean(next.exportCookiesForCli);
  elements.templateError.classList.toggle('hidden', !next.filename_template_error);
  elements.templateError.textContent = next.filename_template_error || '';
  if (next.data_dir) elements.dataDirNote.textContent = `本机数据目录：${next.data_dir}`;
  refreshFilenamePreview();
}

let saveTimer = null;
function saveSettings(patch) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    let result;
    try {
      result = await window.qingying.settingsSet(patch);
    } catch (error) {
      setStatus(`设置保存失败：${error?.message || '主进程没有响应'}`, 'error');
      return;
    }
    if (result && result.ok === false) {
      setStatus(result.error || '设置没有保存成功。', 'error');
      // 命名模板不合法时**保留用户输入并把错误留在框下**：静默改回默认值会让人
      // 以为存好了，实际下载用的是另一套名字。
      if ('filenameTemplate' in patch) {
        elements.templateError.textContent = '没有保存：' + (result.error || '命名模板不合法。');
        elements.templateError.classList.remove('hidden');
        elements.template.classList.add('invalid');
        return;
      }
    }
    elements.template.classList.remove('invalid');
    if (result?.settings) applySettings(result.settings);
  }, 260);
}

async function probeEngines() {
  try {
    elements.engineNote.textContent = '正在探测…';
    engines = await window.qingying.enginesProbe();
    renderEngines();
  } catch {
    elements.engineList.replaceChildren(make('探测引擎失败。', 'li'));
  }
}

// ── 批量 ──────────────────────────────────────────────────────────────────
function readBatchUrls() {
  const lines = elements.batchUrls.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const unique = [...new Set(lines)];
  const valid = unique.filter((line) => {
    try {
      const protocol = new URL(line).protocol;
      return protocol === 'http:' || protocol === 'https:';
    } catch {
      return false;
    }
  });
  elements.batchCount.textContent = `${valid.length} 条有效链接${unique.length !== valid.length ? `（已忽略 ${unique.length - valid.length} 条无效行）` : ''}`;
  return valid.slice(0, 50);
}

async function runBatch() {
  const urls = readBatchUrls();
  if (!urls.length) return setStatus('批量框里没有有效链接。', 'error');
  if (!elements.folder.value.trim()) return setStatus('请先选择下载目录。', 'error');

  elements.batchRun.disabled = true;
  const items = [];
  let failed = 0;
  for (const [index, url] of urls.entries()) {
    setStatus(`批量解析 ${index + 1}/${urls.length}…`);
    const result = await window.qingying.analyze(url, '');
    if (!result?.ok) {
      failed += 1;
      continue;
    }
    const data = result.data;
    const imagesOnly = data.images?.length && !data.videos.length && !data.audios.length;
    if (imagesOnly) {
      items.push({
        url: data.webpageUrl, title: data.title, mode: 'images', images: data.images,
        site: data.sessionId || '', engine: data.engine, outputDir: elements.folder.value.trim(),
      });
    } else {
      const video = data.videos[0] || null;
      const audio = data.audios[0] || null;
      items.push({
        url: data.webpageUrl,
        title: data.title,
        mode: video ? 'combined' : 'audio',
        videoId: video?.id || '',
        videoExt: video?.ext || '',
        videoHasAudio: Boolean(video?.hasAudio),
        audioId: audio?.id || '',
        audioExt: audio?.ext || '',
        audioFormat: settings?.audioFormat || 'mp3',
        site: data.sessionId || '',
        engine: data.engine,
        outputDir: elements.folder.value.trim(),
      });
    }
  }
  elements.batchRun.disabled = false;
  if (!items.length) {
    setStatus(`${urls.length} 条链接都没解析成功，一个任务也没加入。`, 'error');
    return;
  }
  await window.qingying.submitQueue(items);
  setWorkflow(3);
  setStatus(`已加入 ${items.length} 个任务${failed ? `，${failed} 条解析失败被跳过` : ''}。`, 'success');
}

// ── 事件接线 ──────────────────────────────────────────────────────────────
elements.paste.addEventListener('click', async () => {
  try {
    const text = await window.qingying.readClipboard();
    const trimmed = (text || '').trim();
    if (!trimmed) return setStatus('剪贴板里没有文字。', 'error');
    if (/[\r\n]/.test(trimmed) && trimmed.split(/\r?\n/).filter((l) => l.trim()).length > 1) {
      elements.batchPanel.classList.remove('hidden');
      elements.batchToggle.setAttribute('aria-expanded', 'true');
      elements.batchUrls.value = trimmed;
      readBatchUrls();
      hideMediaResult();
      setEmptyState('idle', '剪贴板里有多条链接', '已放进批量框，逐条解析后排队下载。');
      setStatus('检测到多条链接，已填入批量框。');
      return;
    }
    elements.url.value = trimmed;
    hideMediaResult();
    setEmptyState('idle', '链接已粘贴', '确认无误后点"解析链接"。');
    updateContextChips();
    setStatus('已从剪贴板读取链接。');
    elements.url.focus();
  } catch {
    setStatus('无法读取剪贴板。', 'error');
  }
});

elements.analyze.addEventListener('click', () => void analyze());
elements.url.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void analyze();
  }
});
elements.url.addEventListener('input', () => {
  if (media && elements.url.value.trim() !== media.webpageUrl) {
    hideMediaResult();
    setEmptyState('idle', '链接已更改', '请重新解析，避免下载到上一次的内容。');
    setStatus('链接已更改，请重新解析。');
  }
  updateContextChips();
});
elements.contextLogin.addEventListener('click', () => openLogin(contextSiteId));
elements.batchToggle.addEventListener('click', () => {
  const open = elements.batchPanel.classList.toggle('hidden') === false;
  elements.batchToggle.setAttribute('aria-expanded', String(open));
  elements.batchToggle.textContent = open ? '收起批量输入' : '批量粘贴多条链接';
  if (open) elements.batchUrls.focus();
});
elements.batchUrls.addEventListener('input', readBatchUrls);
elements.batchRun.addEventListener('click', () => void runBatch());

document.querySelectorAll('.mode').forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const enabled = [...document.querySelectorAll('.mode:not(:disabled):not(.hidden)')];
    const current = enabled.indexOf(button);
    const offset = event.key === 'ArrowRight' ? 1 : -1;
    const next = enabled[(current + offset + enabled.length) % enabled.length];
    setMode(next.dataset.mode);
    next.focus();
  });
});

elements.videoFormat.addEventListener('change', () => {
  chooseCompatibleAudio();
  syncFormatState();
});
elements.audioFormat.addEventListener('change', syncFormatState);
elements.audioOutput.addEventListener('change', syncFormatState);
elements.download.addEventListener('click', () => void enqueueCurrent());
elements.clearFinished.addEventListener('click', async () => {
  const result = await window.qingying.clearFinished();
  setStatus(`已清除 ${result?.removed ?? 0} 条结束的任务。`, 'success');
});

elements.chooseFolder.addEventListener('click', async () => {
  try {
    const folder = await window.qingying.chooseFolder();
    if (folder) {
      elements.folder.value = folder;
      saveSettings({ outputDir: folder });
      setStatus('下载目录已更新。', 'success');
    }
  } catch {
    setStatus('无法打开文件夹选择窗口。', 'error');
  }
});
elements.folder.addEventListener('change', () => saveSettings({ outputDir: elements.folder.value.trim() }));
elements.folder.addEventListener('change', refreshFilenamePreview);
elements.folder.addEventListener('change', scheduleTempScan);
elements.template.addEventListener('input', () => saveSettings({ filenameTemplate: elements.template.value.trim() }));
elements.templateReset.addEventListener('click', () => {
  elements.template.value = defaultTemplate;
  elements.template.classList.remove('invalid');
  elements.templateError.classList.add('hidden');
  saveSettings({ filenameTemplate: defaultTemplate });
});
elements.settingSubfolder.addEventListener('change', () => saveSettings({ subfolderByPost: elements.settingSubfolder.checked }));
elements.settingExportCookies.addEventListener('change', async () => {
  const result = await window.qingying.settingsSet({ exportCookiesForCli: elements.settingExportCookies.checked });
  if (elements.settingExportCookies.checked) {
    setStatus('导出开关已打开：请在"登录态"里点某一站点的"导出给命令行"，才会真的写入该站点 Cookie 文件。', 'success');
  } else {
    setStatus('导出开关已关闭，命令行接口将按匿名会话解析。');
  }
  if (result?.settings) applySettings(result.settings);
});
elements.settingConcurrency.addEventListener('change', () => saveSettings({ concurrency: Number(elements.settingConcurrency.value) }));
elements.settingRetry.addEventListener('change', () => saveSettings({ autoRetry: Number(elements.settingRetry.value) }));
elements.settingEngine.addEventListener('change', () => saveSettings({ enginePreference: elements.settingEngine.value }));

elements.openFolder.addEventListener('click', async () => {
  const opened = await window.qingying.openFolder(elements.folder.value.trim());
  if (!opened) setStatus('下载目录不存在或无法打开。', 'error');
});
elements.refreshAuth.addEventListener('click', async () => {
  await refreshAuth();
  setStatus('登录态已重新检测。', 'success');
});
elements.clearHistory.addEventListener('click', async () => {
  const result = await window.qingying.historyClear();
  renderHistory(result?.items || []);
  setStatus('下载记录已清空。', 'success');
});
elements.probeEngines.addEventListener('click', () => void probeEngines());

elements.chooseEnginesDir.addEventListener('click', async () => {
  try {
    const result = await window.qingying.chooseEnginesDir();
    if (!result) return;
    engines = result.engines || engines;
    renderEngines();
    const found = ['yt_dlp', 'gallery_dl', 'ffmpeg'].filter((key) => engines?.[key]?.available).length;
    setStatus(`引擎目录已设为 ${result.dir}（现在找到 ${found} 个）。`, 'success');
  } catch {
    setStatus('无法打开目录选择窗口。', 'error');
  }
});

// 两步确认：不用弹窗，但绝不"一点就把文件删了"。
let tempArmed = false;
let tempArmTimer = null;
elements.tempClean.addEventListener('click', async () => {
  if (!tempArmed) {
    tempArmed = true;
    elements.tempClean.textContent = '确认清理（再点一次）';
    elements.tempClean.classList.add('danger');
    clearTimeout(tempArmTimer);
    tempArmTimer = setTimeout(() => {
      tempArmed = false;
      elements.tempClean.textContent = '清理这些分片';
      elements.tempClean.classList.remove('danger');
    }, 5000);
    return;
  }
  const result = await window.qingying.cleanTempFiles(elements.folder.value.trim());
  tempArmed = false;
  elements.tempClean.textContent = '清理这些分片';
  elements.tempClean.classList.remove('danger');
  if (result?.error) {
    setStatus(result.error, 'error');
  } else if (result?.removed) {
    setStatus(`已清掉 ${result.removed} 个未完成分片（${result.size_text || humanBytes(result.bytes)}），成品文件没有动。`, 'success');
  } else {
    setStatus('没有删掉任何文件。', 'error');
  }
  if (result?.failed?.length) setStatus(`有 ${result.failed.length} 个分片删不掉（可能被引擎占用），稍后再试。`, 'error');
  await refreshTempFiles();
});

window.qingying.onQueueChanged((snapshot) => {
  renderQueue(snapshot);
  if (snapshot?.settings) applySettings(snapshot.settings);
  if (snapshot?.engines) {
    engines = snapshot.engines;
    renderEngines();
  }
});
window.qingying.onAuthChanged((snapshot) => {
  auth = snapshot;
  renderAuth();
  updateContextChips();
});
window.qingying.onEnginesChanged((record) => {
  if (!record) return;
  engines = record;
  renderEngines();
});

// ── 启动 ──────────────────────────────────────────────────────────────────
setMode('combined');
renderEngines();
renderAuth();

async function bootstrap() {
  try {
    const [info, settingsResult, queueResult, historyResult, enginesResult, sites] = await Promise.all([
      window.qingying.getAppInfo(),
      window.qingying.settingsGet(),
      window.qingying.listQueue(),
      window.qingying.historyList(),
      window.qingying.enginesProbe(),
      window.qingying.sitesList(),
    ]);
    applySiteCatalog(sites);
    if (info?.version) elements.appVersion.textContent = `v${info.version}`;
    if (info?.default_template) defaultTemplate = info.default_template;
    if (Array.isArray(info?.template_fields)) {
      elements.templateFieldHint.textContent = '可用字段：' + info.template_fields.join('、') + '；必须包含 %(ext)s。';
    }
    engines = enginesResult;
    renderEngines();
    applySettings(settingsResult);
    if (queueResult) {
      renderQueue(queueResult);
      if (queueResult.settings) applySettings(queueResult.settings);
    }
    renderHistory(historyResult?.items || []);
    auth = await window.qingying.authStatus();
    renderAuth();
    updateContextChips();
    if (info?.data_dir) elements.dataDirNote.textContent = `本机数据目录：${info.data_dir}（设置、历史、登录态导出都只在这里，不在仓库里）。`;
    void refreshTempFiles();
  } catch (error) {
    setStatus(`初始化失败：${error?.message || '未知错误'}`, 'error');
  }
}

void bootstrap();

const winControls = window.qingying?.windowControls;
if (winControls) {
  const maxBtn = document.getElementById('win-maximize');
  const setMax = (value) => maxBtn?.setAttribute('aria-expanded', String(value));
  document.getElementById('win-minimize')?.addEventListener('click', () => void winControls.minimize());
  maxBtn?.addEventListener('click', () => void winControls.toggleMaximize());
  document.getElementById('win-close')?.addEventListener('click', () => void winControls.close());
  winControls.isMaximized().then(setMax).catch(() => {});
  winControls.onMaximizedChange?.(setMax);
  for (const region of document.querySelectorAll('.brand, .workspace-header')) {
    region.addEventListener('dblclick', (event) => {
      if (event.target instanceof Element && event.target.closest('button, a, input, select')) return;
      void winControls.toggleMaximize();
    });
  }
}
