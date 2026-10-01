'use strict';
// 项目自检（npm run check）：语法、界面接线、Agent 契约、引擎核心行为。
// 不联网、不写用户数据，可在任何机器上跑。控制台按 GBK 输出，所以这里只打印 ASCII。
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;
let checks = 0;

function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

function walk(dir, filter, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'resources') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, filter, out);
    else if (filter.test(entry.name)) out.push(full);
  }
  return out;
}

// 1) 语法
for (const file of walk(ROOT, /\.(cjs|mjs|js)$/)) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    report('syntax ' + path.relative(ROOT, file), true);
  } catch (error) {
    report('syntax ' + path.relative(ROOT, file), false, String(error.stderr || error.message).split('\n').slice(0, 3).join(' '));
  }
}

// 2) JSON 可解析
for (const file of ['package.json', 'agent/launch.json'].map((f) => path.join(ROOT, f))) {
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
    report('json ' + path.relative(ROOT, file), true);
  } catch (error) {
    report('json ' + path.relative(ROOT, file), false, error.message);
  }
}

// 3) 界面接线：app.js 里引用的 id/class 必须在 index.html 里存在
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const referenced = [...appJs.matchAll(/querySelector\('#([a-zA-Z0-9_-]+)'\)|getElementById\('([a-zA-Z0-9_-]+)'\)/g)]
  .map((m) => m[1] || m[2]);
const missingIds = [...new Set(referenced)].filter((id) => !htmlIds.has(id));
report('renderer ids referenced exist in html', missingIds.length === 0, missingIds.join(','));

// 4) preload 暴露的方法与 app.js 调用的一致（少一边就是界面报 undefined）
const preload = fs.readFileSync(path.join(ROOT, 'electron', 'preload.cjs'), 'utf8');
const exposed = new Set([...preload.matchAll(/^\s{2}([a-zA-Z]+):\s*\(/gm)].map((m) => m[1]));
const called = new Set([...appJs.matchAll(/window\.qingying\.([a-zA-Z]+)/g)].map((m) => m[1]));
const notExposed = [...called].filter((name) => !exposed.has(name) && name !== 'windowControls');
const neverUsed = [...exposed].filter((name) => !called.has(name));
report('renderer calls covered by preload', notExposed.length === 0, notExposed.join(','));
report('preload surface all used by renderer', neverUsed.length === 0, neverUsed.join(','));

// 5) IPC channel 一致性：preload invoke 的 channel 必须由主进程 handle
const main = fs.readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));
const unhandled = [...invoked].filter((channel) => !handled.has(channel));
report('every invoked channel is handled', unhandled.length === 0, unhandled.join(','));

// 6) Agent 契约
const launch = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'launch.json'), 'utf8'));
report('agent launch.json port 8793', launch.command === 'node' && launch.ready_port === 8793
  && launch.args.join() === 'agent/server.mjs', JSON.stringify(launch));
const serverSrc = fs.readFileSync(path.join(ROOT, 'agent', 'server.mjs'), 'utf8');
report('agent server default port 8793', /PROJECT_DEFAULT_PORT = 8793/.test(serverSrc));

// 7) 引擎核心行为（无网络）
const core = require(path.join(ROOT, 'electron', 'engine-core.cjs'));

report('template accepts default', core.validateFilenameTemplate(core.DEFAULT_FILENAME_TEMPLATE).ok);
report('template rejects unknown field', !core.validateFilenameTemplate('%(hackme)s.%(ext)s').ok);
report('template rejects missing ext', !core.validateFilenameTemplate('%(title)s').ok);
report('template rejects control chars', !core.validateFilenameTemplate('a\n%(ext)s').ok);
report('preview trims by bytes', core.previewFilename('%(title).6B.%(ext)s', { title: 'abcdefghij', ext: 'mp4' }) === 'abcdef.mp4',
  core.previewFilename('%(title).6B.%(ext)s', { title: 'abcdefghij', ext: 'mp4' }));
report('filename strips illegal chars', core.sanitizeFileName('a<b>:c"d/e|f?g*h') === 'abcdefgh', core.sanitizeFileName('a<b>:c"d/e|f?g*h'));

const planImages = core.planEngine('https://www.instagram.com/p/abc/', { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto');
report('image site plans yt-dlp first', planImages.primary === 'yt-dlp' && planImages.chain[1].engine === 'gallery-dl');
const planVideo = core.planEngine('https://www.bilibili.com/video/BV1', { yt_dlp: { available: true }, gallery_dl: { available: false } }, 'auto');
report('video plan marks missing fallback', planVideo.chain.length === 2 && planVideo.chain[1].unavailable === true);

const diag = core.classifyParseError('ERROR: [douyin] Requested format is not available, login required', core.LOGIN_SITES.douyin, 'yt-dlp');
report('login failure has actionable remedy', diag.kind === 'login_required' && diag.remedies.some((r) => r.action === 'login'));
report('network failure suggests network', core.classifyParseError('Unable to download webpage: timed out', null, 'yt-dlp').kind === 'network');

const summary = core.summarizeLoginCookies(core.LOGIN_SITES.bilibili, [
  { name: 'SESSDATA', value: 'SECRET-VALUE', domain: '.bilibili.com', expirationDate: Math.floor(Date.now() / 1000) + 3600 },
  { name: 'junk', value: 'X', domain: '.example.com' },
]);
const serialized = JSON.stringify(summary);
report('cookie summary never leaks value', !serialized.includes('SECRET-VALUE') && !serialized.includes('"X"'), serialized);
report('cookie summary reports login', summary.loggedIn && summary.matchedCookieNames[0] === 'SESSDATA');

const args = core.buildDownloadArgs({
  url: 'https://example.com/v',
  outputDir: 'C:/tmp/out',
  mode: 'combined',
  videoId: '160',
  videoExt: 'mp4',
  videoHasAudio: false,
  audioId: '140',
  audioExt: 'm4a',
  site: null,
  cookieFile: '',
  ffmpegLocation: 'C:/ffmpeg',
  filenameTemplate: '%(title).180B [%(id)s].%(ext)s',
});
const joined = args.join(' ');
report('download args merge to mp4 when compatible', joined.includes('-f 160+140') && joined.includes('--merge-output-format mp4'));
report('download args keep continue + ffmpeg path', joined.includes('--continue') && joined.includes('C:/ffmpeg'));
report('download args use absolute -o', args[args.indexOf('-o') + 1].startsWith('C:'));

const badArgs = core.buildDownloadArgs({
  url: 'https://example.com/v', outputDir: 'C:/tmp/out', mode: 'audio', audioId: '140',
  audioFormat: 'flac', site: null, cookieFile: '', ffmpegLocation: 'x', filenameTemplate: ';rm -rf',
});
report('bad template falls back to default, not to shell', badArgs.join(' ').includes(core.DEFAULT_FILENAME_TEMPLATE));
report('unknown audio format clamps to mp3', badArgs.includes('mp3'));

const parsed = core.parseGalleryDlJson(JSON.stringify([
  [2, { url: 'https://x/1.jpg', extension: 'jpg', filename: 'a' }],
  [3, 'https://x/2.png'],
  [3, 'https://x/notimage.txt'],
]));
report('gallery-dl json parsed, non-images dropped', parsed.length === 2 && parsed[1].ext === 'png', JSON.stringify(parsed.map((p) => p.ext)));

const mapped = core.mapFormats({ formats: [
  { format_id: '160', ext: 'mp4', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 2000 },
  { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', abr: 129 },
] });
report('mapFormats splits video/audio', mapped.videos.length === 1 && mapped.audios.length === 1);

report('normalizeMediaUrl rewrites modal_id',
  core.normalizeMediaUrl('https://www.douyin.com/?modal_id=1234567890123') === 'https://www.douyin.com/video/1234567890123');
report('iesdouyin recognized as douyin', core.matchLoginSite('https://www.iesdouyin.com/share/video/1')?.id === 'douyin');
report('unknown host has no site', core.matchLoginSite('https://example.com/x') === null);

// 8) 设置/历史读写只落在给定目录
const tmp = path.join(ROOT, '.check-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
try {
  const saved = core.writeSettings(tmp, { outputDir: 'C:/x', autoRetry: 99, concurrency: 0 });
  report('settings clamped', saved.autoRetry === 5 && saved.concurrency === 1);
  core.appendHistory(tmp, { id: 't1', url: 'https://x', title: 'A', status: 'done', bytes: 10, files: [{ path: 'C:/x/A', bytes: 10 }] });
  const history = core.readHistory(tmp);
  report('history persisted and readable', history.length === 1 && history[0].bytes === 10);
  report('history has no cookie field', !JSON.stringify(history).toLowerCase().includes('cookie'));
  core.clearHistory(tmp);
  report('history cleared', core.readHistory(tmp).length === 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
