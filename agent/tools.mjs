#!/usr/bin/env node
// 清影下载器 — Agent 工具实现（本项目唯一需要写的文件；server.mjs / mcp-server.mjs 用标准模板）。
// 契约见 personal-agent-hub/docs/AGENT_API_STANDARD.md
//
// 所有工具都调用项目自己的真实能力：electron/engine-core.cjs 与桌面界面共用同一份实现
// （站点判定、引擎发现、格式映射、下载参数、进度解析、落盘核对、设置/历史/登录态存储）。
// 没有任何写死的假数据；本机没有的能力一律如实报"未安装/不可用"。
//
// Cookie 边界：这个服务是无头的，读不到 Electron session。它只用用户在界面里显式导出的
// 登录态文件（settings.exportCookiesForCli），并且**任何返回值里都不含 Cookie 值** ——
// 只报状态、Cookie 名与过期时间。
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AgentError } from './server.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const core = require(path.join(ROOT, 'electron', 'engine-core.cjs'));
const pkg = require(path.join(ROOT, 'package.json'));

export const project = {
  name: 'qingying',
  version: pkg.version,
  summary: '清影下载器：yt-dlp + gallery-dl 双引擎，链接解析、下载任务、站点登录态与设置。',
};

// ── 本机数据目录：与 Electron 的 userData 同一处，界面与接口看到的是同一份状态 ──
function dataDir() {
  const fromEnv = core.safeText(process.env.QINGYING_DATA_DIR, 1024).trim();
  if (fromEnv) return path.resolve(fromEnv);
  const base = process.env.APPDATA
    || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(base, 'qingying-downloader', 'qingying');
}

function engineOptions(dir) {
  const settings = safeSettings(dir);
  const roots = [];
  const envDir = core.safeText(process.env.QINGYING_ENGINE_DIR, 1024).trim();
  if (envDir) roots.push(envDir);
  if (settings.enginesDir) roots.push(settings.enginesDir);
  roots.push(path.join(ROOT, 'resources', 'bin'));
  roots.push(path.join(ROOT, 'resources'));
  return { overrides: {}, extraRoots: roots };
}

function safeSettings(dir) {
  try {
    return core.readSettings(dir);
  } catch {
    return { ...core.DEFAULT_SETTINGS };
  }
}

function requireUrl(input) {
  const raw = core.safeText(input.url, 4096).trim();
  if (!raw) throw new AgentError('bad_input', '缺少参数 url。');
  if (!core.isHttpUrl(raw)) throw new AgentError('bad_input', 'url 必须是 http/https 开头的完整网址。');
  return core.normalizeMediaUrl(raw);
}

function resolveOutputDir(input, settings) {
  const explicit = core.safeText(input.output_dir, 1024).trim();
  const candidate = explicit || settings.outputDir || path.join(os.homedir(), 'Downloads');
  const abs = path.resolve(candidate);
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) {
    throw new AgentError('bad_input', `下载目录不是目录：${abs}`);
  }
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

// 无头模式下的 Cookie 来源：只认用户在界面里显式导出的文件（不会被删除或改写）。
function makeCookieProvider(dir, settings) {
  return async (site) => {
    if (!site) return '';
    if (!settings.exportCookiesForCli) return '';
    return core.exportedCookieFile(dir, site.id);
  };
}

// ── 本进程内的任务登记表（进度查询用；历史另存 userData/history.json）──────
const jobs = new Map();
let jobSeq = 0;

function jobView(job) {
  return {
    id: job.id,
    url: job.url,
    title: job.title,
    mode: job.mode,
    engine: job.engine,
    used_engine: job.used_engine,
    status: job.status,
    progress: job.progress,
    bytes: job.bytes,
    size_text: core.formatBytes(job.bytes) || '0 B',
    file_count: job.files.length,
    files: job.files.slice(0, 12).map((f) => ({ path: f.path, bytes: f.bytes, size: core.formatBytes(f.bytes) || '' })),
    output_dir: job.outputDir,
    error: job.error,
    kind: job.kind,
    created_at: job.created_at,
    finished_at: job.finished_at,
  };
}

function truncate(list, max) {
  return { items: list.slice(0, max), total: list.length, truncated: list.length > max };
}

// ── 工具实现 ──────────────────────────────────────────────────────────────
const tools = [
  {
    name: 'qingying.engines',
    description: '探测本机 yt-dlp / gallery-dl / ffmpeg 是否可用，返回真实版本号、命中的路径与来源（env、安装目录、PATH 或未找到）。判断能力边界时先用它。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: '是否重新跑一次 --version（默认 true）。' },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const dir = dataDir();
      const engines = await core.probeEngines(engineOptions(dir));
      return {
        data_dir: dir,
        engines,
        engines_dir: core.enginesDirStatus(safeSettings(dir).enginesDir),
        search_roots: engineOptions(dir).extraRoots,
        env_overrides: {
          'yt-dlp': process.env.QINGYING_YT_DLP || '',
          'gallery-dl': process.env.QINGYING_GALLERY_DL || '',
          ffmpeg: process.env.QINGYING_FFMPEG || '',
          engine_dir: process.env.QINGYING_ENGINE_DIR || '',
        },
        note: input.refresh === false ? '本次仍重新探测（版本探测很便宜，避免读到过期缓存）。' : '',
      };
    },
  },
  {
    name: 'qingying.parse',
    description: '解析一条链接：自动判定用哪个引擎并给出原因，返回候选画质/音轨/图片数、标题、作者、时长与按当前命名模板算出的目标文件名。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https 链接。' },
        engine_preference: { type: 'string', enum: ['auto', 'yt-dlp', 'gallery-dl'], description: '覆盖设置里的引擎偏好，只对本次解析生效。' },
        max_formats: { type: 'integer', description: '最多返回几个候选格式，默认 12。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (input) => {
      const dir = dataDir();
      const settings = safeSettings(dir);
      const url = requireUrl(input);
      const engines = await core.probeEngines(engineOptions(dir));
      const result = await core.analyzeUrl({
        url,
        engines,
        preference: input.engine_preference || settings.enginePreference,
        cookieProvider: makeCookieProvider(dir, settings),
      });
      if (!result.ok) {
        return {
          ok: false,
          url,
          site: core.matchLoginSite(url)?.id || '',
          reason: result.kind || 'unknown',
          reason_text: reasonText(result.kind),
          message: result.error,
          engine_plan: result.engine_plan || [],
          engine_chain: result.engine_attempts || [],
          next_actions: (result.remedies || []).map((r) => ({ action: r.action, label: r.label, detail: r.detail })),
        };
      }
      const data = result.data;
      const videos = truncate(data.videos, Number(input.max_formats) || 12);
      const audios = truncate(data.audios, Number(input.max_formats) || 12);
      const images = truncate(data.images || [], 30);
      return {
        ok: true,
        url,
        engine: data.engine,
        engine_version: data.engine_version || '',
        engine_source: data.engine_source || '',
        engine_reason: data.engine_reason,
        engine_chain: data.engine_chain,
        engine_plan: data.engine_plan || [],
        cookie_source: data.cookie_source || 'none',
        site: data.sessionId,
        site_label: data.siteLabel,
        title: data.title,
        uploader: data.uploader,
        duration: data.duration,
        duration_text: core.formatDuration(data.duration),
        counts: { videos: videos.total, audios: audios.total, images: images.total },
        videos: videos.items,
        videos_truncated: videos.truncated,
        audios: audios.items,
        audios_truncated: audios.truncated,
        images: images.items,
        images_truncated: images.truncated,
        output_dir: settings.outputDir || path.join(os.homedir(), 'Downloads'),
        filename_preview: core.previewFilename(settings.filenameTemplate, {
          title: data.title,
          id: '',
          ext: data.videos[0]?.ext || data.audios[0]?.ext || 'mp4',
          uploader: data.uploader,
        }),
      };
    },
  },
  {
    name: 'qingying.download',
    description: '提交并执行一次真实下载（risk=exec，必须传 confirm:true）。返回真实落盘文件路径与字节数。未给格式 id 时自动先解析并挑最高画质。',
    risk: 'exec',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的链接。' },
        confirm: { type: 'boolean', description: '必须显式传 true，表示确认要真实写盘。' },
        mode: { type: 'string', enum: ['combined', 'video', 'audio', 'images'], description: '默认按解析结果自动选：有音视频=combined，只有图=images。' },
        video_id: { type: 'string', description: 'yt-dlp format_id；留空自动挑。' },
        audio_id: { type: 'string', description: 'yt-dlp format_id；留空自动挑。' },
        audio_format: { type: 'string', enum: ['mp3', 'm4a', 'opus', 'wav'] },
        engine: { type: 'string', enum: ['yt-dlp', 'gallery-dl'] },
        output_dir: { type: 'string', description: '绝对或相对目录；留空用设置里的下载目录。' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    handler: async (input) => {
      if (input.confirm !== true) {
        throw new AgentError('confirm_required', 'qingying.download 会真实写盘：必须显式传 confirm:true 才会执行。');
      }
      const dir = dataDir();
      const settings = safeSettings(dir);
      const url = requireUrl(input);
      const engines = await core.probeEngines(engineOptions(dir));
      const outputDir = resolveOutputDir(input, settings);
      const site = core.matchLoginSite(url);
      const provideCookies = makeCookieProvider(dir, settings);
      const cookieFile = await provideCookies(site);

      const parse = await core.analyzeUrl({
        url,
        engines,
        preference: settings.enginePreference,
        cookieProvider: provideCookies,
      });
      if (!parse.ok) {
        throw new AgentError('parse_failed', `${parse.error}（原因：${parse.kind}；可执行动作：${(parse.remedies || []).map((r) => r.label).join('、') || '无'}）`);
      }
      const media = parse.data;
      if (site && site.loginRequired && !cookieFile) {
        throw new AgentError('login_required', `${site.label} 必须登录才能下载。无头接口读不到界面里的浏览器会话；请在清影下载器窗口登录该站点，并在"登录态"面板打开"导出给命令行"后重试。`);
      }

      let mode = input.mode || '';
      if (!mode) {
        if (media.images.length && !media.videos.length && !media.audios.length) mode = 'images';
        else if (media.audios.length && !media.videos.length) mode = 'audio';
        else mode = 'combined';
      }

      jobSeq += 1;
      const id = 'agent-' + Date.now().toString(36) + '-' + jobSeq;
      const job = {
        id,
        url,
        title: media.title,
        mode,
        engine: input.engine || media.engine,
        used_engine: '',
        status: 'running',
        progress: { percent: '', speed: '', eta: '' },
        bytes: 0,
        files: [],
        outputDir,
        error: '',
        kind: '',
        created_at: new Date().toISOString(),
        finished_at: '',
      };
      jobs.set(id, job);
      while (jobs.size > 100) {
        const oldest = [...jobs.keys()].find((key) => jobs.get(key).status !== 'running');
        if (!oldest) break;
        jobs.delete(oldest);
      }

      const hooks = {
        onProgress: (payload) => {
          job.progress = {
            percent: core.safeText(payload.percent, 20).trim(),
            speed: core.safeText(payload.speed, 30).trim(),
            eta: core.safeText(payload.eta, 40).trim(),
          };
        },
      };

      let result;
      // 不删除 cookieFile —— 它是用户在界面里显式导出的长期文件，
      // 删掉等于把登录态导出关掉，超出本次下载的授权范围。
      if (mode === 'images') {
        if ((input.engine === 'gallery-dl' || settings.enginePreference === 'gallery-dl') && engines.gallery_dl?.available) {
          // engineOptions 必须传：gallery-dl 常常只在设置的"引擎目录"里、不在 PATH 上。
          result = await core.runGalleryDlDownload({ url, outputDir, site, cookieFile, engineOptions: engineOptions(dir) }, hooks);
        } else {
          result = await core.runImageListDownload({
            url,
            outputDir,
            images: media.images,
            title: media.title,
            subfolder: settings.subfolderByPost,
            cookieHeader: '',
            refererOrigin: core.safeText(new URL(url).origin, 300),
          }, hooks);
        }
      } else {
        const video = media.videos.find((v) => v.id === input.video_id) || media.videos[0] || null;
        const audio = media.audios.find((a) => a.id === input.audio_id) || media.audios[0] || null;
        if (mode !== 'audio' && !video) throw new AgentError('bad_input', '这条链接没有可下载的视频轨道。');
        if (mode === 'audio' && !audio) throw new AgentError('bad_input', '这条链接没有独立音频轨道可单独下载。');
        if (mode === 'combined' && !video.hasAudio && !audio) {
          throw new AgentError('bad_input', '合并模式需要一条音频轨道，但解析结果里没有。');
        }
        if (!engines.yt_dlp?.available) {
          throw new AgentError('engine_missing', '本机没有可用的 yt-dlp，无法下载音视频。');
        }
        result = await core.runEngineDownload({
          url,
          outputDir,
          site,
          cookieFile,
          mode,
          videoId: video.id,
          videoExt: core.safeExt(video.ext),
          videoHasAudio: Boolean(video.hasAudio),
          audioId: audio ? audio.id : '',
          audioExt: audio ? core.safeExt(audio.ext) : '',
          audioFormat: core.AUDIO_FORMATS.includes(input.audio_format) ? input.audio_format : settings.audioFormat,
          ffmpegLocation: resolveFfmpeg(engines),
          filenameTemplate: settings.filenameTemplate,
          subfolderByPost: false,
          retries: 20,
          concurrentFragments: 3,
          engineOptions: engineOptions(dir),
        }, hooks);
      }

      job.files = result.files || [];
      job.bytes = Number(result.bytes) || 0;
      job.used_engine = result.engine || (mode === 'images' ? '内置取图器' : 'yt-dlp');
      job.status = result.ok ? 'done' : (result.cancelled ? 'cancelled' : 'failed');
      job.error = result.ok ? '' : core.safeText(result.error, 500);
      job.kind = result.kind || '';
      job.finished_at = new Date().toISOString();

      try {
        core.appendHistory(dir, {
          id: job.id,
          url,
          title: job.title,
          engine: job.used_engine,
          mode,
          site: site ? site.id : '',
          status: job.status,
          outputDir,
          files: job.files,
          bytes: job.bytes,
          error: job.error,
          attempts: 1,
          finished_at: job.finished_at,
        });
      } catch {}

      if (!result.ok) {
        const partial = job.files.length ? `（已落盘 ${job.files.length} 个文件，${core.formatBytes(job.bytes)}）` : '';
        throw new AgentError('download_failed', `${job.error || '下载失败'}（原因：${reasonText(job.kind)}）${partial} 任务号 ${id}`);
      }

      return {
        task_id: id,
        status: job.status,
        engine: job.used_engine,
        mode,
        output_dir: outputDir,
        bytes: job.bytes,
        size_text: core.formatBytes(job.bytes) || '0 B',
        files: job.files.map((f) => ({ path: f.path, bytes: f.bytes, size: core.formatBytes(f.bytes) || '' })),
        file_count: job.files.length,
        ms: new Date(job.finished_at) - new Date(job.created_at),
        title: media.title,
        cookie_used: Boolean(cookieFile),
      };
    },
  },
  {
    name: 'qingying.tasks',
    description: '查询本 Agent 服务进程里下载任务的状态与进度（运行中含百分比/速度/剩余，结束后含文件与字节数）。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '只看某一条任务。' },
        status: { type: 'string', enum: ['running', 'done', 'failed', 'cancelled'] },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      let list = [...jobs.values()];
      if (input.task_id) list = list.filter((job) => job.id === core.safeText(input.task_id, 40));
      if (input.status) list = list.filter((job) => job.status === input.status);
      const view = list.sort((a, b) => b.created_at.localeCompare(a.created_at)).map(jobView);
      return { count: view.length, tasks: view.slice(0, 50), truncated: view.length > 50 };
    },
  },
  {
    name: 'qingying.history',
    description: '读取本机下载历史（界面与接口共用同一份 history.json）：状态、引擎、字节数与真实文件路径。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回多少条，默认 20，上限 100。' },
        status: { type: 'string', enum: ['done', 'failed', 'cancelled', 'paused'] },
        site: { type: 'string', enum: core.SITE_IDS },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const dir = dataDir();
      const all = core.readHistory(dir);
      let list = all;
      if (input.status) list = list.filter((item) => item.status === input.status);
      if (input.site) list = list.filter((item) => item.site === input.site);
      const limit = Math.min(100, Math.max(1, Number(input.limit) || 20));
      return {
        total: list.length,
        limit,
        items: list.slice(0, limit),
        history_file: core.dataPaths(dir).history,
        note: '历史里只有网址/标题/路径/字节数，不含 Cookie。',
      };
    },
  },
  {
    name: 'qingying.auth_status',
    description: '列出各站点登录态：是否已登录、依据哪个 Cookie 名判定、最早过期时间、是否已导出给命令行。**只报状态，绝不返回 Cookie 值。**',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const dir = dataDir();
      const settings = safeSettings(dir);
      const snapshot = core.readAuthState(dir);
      const fromExports = core.authSnapshotFromExports(dir);
      const sites = core.SITE_IDS.map((siteId) => {
        const site = core.LOGIN_SITES[siteId];
        const live = snapshot.sites && snapshot.sites[siteId];
        const exported = fromExports.sites[siteId];
        return {
          site: siteId,
          label: site.label,
          login_required: site.loginRequired,
          in_app_session: live ? {
            logged_in: Boolean(live.logged_in),
            judged_by: live.matched_cookie_names || [],
            expires_at: live.expires_at || '',
            expired_detected: Boolean(live.expired_detected),
            checked_at: live.checked_at || '',
            session_dir_exists: Boolean(live.has_partition),
          } : { logged_in: false, judged_by: [], expires_at: '', expired_detected: false, checked_at: '', session_dir_exists: false },
          cli_export: exported.exported ? {
            available: true,
            logged_in: Boolean(exported.loggedIn),
            expires_at: exported.earliestExpiry || '',
            checked_at: exported.checked_at || '',
          } : { available: false, logged_in: false, expires_at: '', checked_at: '' },
          relogin: '在清影下载器窗口点该站点的"登录"，窗口关闭后状态自动刷新。',
        };
      });
      return {
        updated_at: snapshot.updated_at || '',
        snapshot_source: snapshot.source || 'none',
        cli_export_enabled: Boolean(settings.exportCookiesForCli),
        cookie_dir: core.dataPaths(dir).cookieDir,
        sites,
        privacy: '本工具只输出状态与 Cookie 名称，不输出任何 Cookie 值。',
      };
    },
  },
  {
    name: 'qingying.settings',
    description: '读取当前设置：下载目录、命名模板、并发数、失败重试次数、引擎偏好、音频格式、是否导出登录态。',
    risk: 'read',
    input_schema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const dir = dataDir();
      const settings = safeSettings(dir);
      return {
        data_dir: dir,
        settings,
        filename_template_valid: core.validateFilenameTemplate(settings.filenameTemplate).ok,
        allowed_template_fields: core.TEMPLATE_FIELDS,
        downloads_dir_exists: fs.existsSync(settings.outputDir || ''),
      };
    },
  },
  {
    name: 'qingying.settings_set',
    description: '修改设置（写入界面共用的 settings.json）。命名模板会先做白名单校验，不合法直接拒绝并说明原因。',
    risk: 'write',
    input_schema: {
      type: 'object',
      properties: {
        output_dir: { type: 'string' },
        filename_template: { type: 'string' },
        concurrency: { type: 'integer' },
        auto_retry: { type: 'integer' },
        engine_preference: { type: 'string', enum: ['auto', 'yt-dlp', 'gallery-dl'] },
        audio_format: { type: 'string', enum: core.AUDIO_FORMATS },
        subfolder_by_post: { type: 'boolean' },
        export_cookies_for_cli: { type: 'boolean' },
        engines_dir: { type: 'string', description: '引擎目录，例如安装包里的 resources/bin。' },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const dir = dataDir();
      const patch = {};
      if (input.output_dir !== undefined) patch.outputDir = core.safeText(input.output_dir, 1024);
      if (input.filename_template !== undefined) patch.filenameTemplate = core.safeText(input.filename_template, 200);
      if (input.concurrency !== undefined) patch.concurrency = input.concurrency;
      if (input.auto_retry !== undefined) patch.autoRetry = input.auto_retry;
      if (input.engine_preference !== undefined) patch.enginePreference = input.engine_preference;
      if (input.audio_format !== undefined) patch.audioFormat = input.audio_format;
      if (input.subfolder_by_post !== undefined) patch.subfolderByPost = input.subfolder_by_post;
      if (input.export_cookies_for_cli !== undefined) patch.exportCookiesForCli = input.export_cookies_for_cli;
      if (input.engines_dir !== undefined) patch.enginesDir = core.safeText(input.engines_dir, 1024);
      const saved = core.writeSettings(dir, patch);
      if (saved.filename_template_error) {
        throw new AgentError('bad_input', saved.filename_template_error);
      }
      return { settings: saved, settings_file: core.dataPaths(dir).settings };
    },
  },
];

function resolveFfmpeg(engines) {
  if (engines.ffmpeg?.available) return engines.ffmpeg.path;
  return 'ffmpeg';
}

// 失败原因的中英文对照：调用方（模型或脚本）拿到 kind 之外还要拿到一句能行动的话。
const REASON_TEXT = {
  bad_url: '链接不是 http/https 完整网址',
  engine_missing: '本机没有可用的引擎（yt-dlp / gallery-dl）',
  login_required: '需要登录该站点',
  needs_login: '可能需要登录（站点拒绝了匿名请求）',
  site_changed: '站点改版或本机引擎版本落后',
  unsupported_site: '该站点没有对应的解析器',
  unsupported_url: '这不是具体内容页（首页/搜索页/用户页）',
  no_formats: '两个引擎都没有返回可下载内容',
  link_gone: '内容已失效、被删除或设为私密',
  network: '网络不通或超时',
  proxy: '被代理或证书拦下',
  rate_limited: '站点在限流',
  unknown: '原因未归类，看 message 与 engine_chain',
};

function reasonText(kind) {
  return REASON_TEXT[kind] || kind || '未知原因';
}

export { tools };
