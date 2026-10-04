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
  // 控制台是 GBK：详情一律先转 ASCII，避免中文把输出打成乱码被误判成失败。
  const asciiDetail = detail === undefined ? '' : String(detail).replace(/[^ -~]/g, '?');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${asciiDetail ? ' :: ' + asciiDetail : ''}`);
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
const agentTools = fs.readFileSync(path.join(ROOT, 'agent', 'tools.mjs'), 'utf8');
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

// 6b) 本机接口守卫：两条接口必须走同一份判据，且不许留通配 CORS / 任意输出目录。
//     （行为判据在 scripts/api-guard.test.cjs，这里守的是"接线有没有被改回去"。）
const localGuardSrc = fs.readFileSync(path.join(ROOT, 'electron', 'local-guard.cjs'), 'utf8');
const agentApiSrc = fs.readFileSync(path.join(ROOT, 'electron', 'agent-api.cjs'), 'utf8');
report('guard module exists and is required by both api surfaces',
  /require\('\.\/local-guard\.cjs'\)/.test(agentApiSrc) && /'..', 'electron', 'local-guard\.cjs'/.test(serverSrc),
  '');
report('guard checks Host before any business route',
  /checkLocalGuard\(req/.test(agentApiSrc) && /replyGuardDenied/.test(agentApiSrc)
  && /checkLocalGuard\(req/.test(serverSrc), '');
report('Origin is never compared against the request own Host (DNS rebinding)',
  !/headers\.host[\s\S]{0,40}(===|==)\s*origin|origin[\s\S]{0,40}(===|==)\s*req\.headers\.host/i.test(localGuardSrc));
// 只在"非注释行"上判跨域头：把判据写在注释里说明边界是允许的，把 ACAO 发出去才是要挡的。
function acaoCodeLines(src) {
  return src.split(/\r?\n/).filter((line) => /access-control-allow/i.test(line))
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}
report('no wildcard CORS emitted on any local api surface',
  acaoCodeLines(agentApiSrc).length === 0 && acaoCodeLines(serverSrc).length === 0
  && /guard\.localHeaders/.test(agentApiSrc),
  acaoCodeLines(agentApiSrc).concat(acaoCodeLines(serverSrc)).join(' | ').slice(0, 120));
report('non-GET requires a token on both surfaces',
  /\{\s*port,\s*token[,}]/.test(agentApiSrc) && /token:\s*tokenInfo\.token/.test(serverSrc));
report('token file lives in per-user app-data (0600)',
  /apiToken/.test(fs.readFileSync(path.join(ROOT, 'electron', 'engine-core.cjs'), 'utf8'))
  && /mode:\s*0o600/.test(localGuardSrc) && /chmodSync\(file, 0o600\)/.test(localGuardSrc));
report('in-app api refuses outputDir outside the download root',
  /resolveOutputDir/.test(agentApiSrc) && /output_dir_refused|output_dir_outside_root|!target\.ok/.test(agentApiSrc));
report('main wires the containment helper',
  /resolveContainedOutputDir/.test(main) && /downloadRoots/.test(main));
report('agent tool output_dir goes through the same containment',
  /resolveContainedOutputDir/.test(agentTools));
report('mcp bridge sends the local token header',
  /x-qingying-token/.test(fs.readFileSync(path.join(ROOT, 'agent', 'mcp-server.mjs'), 'utf8')));
report('both api surfaces bind loopback only via listenLocal',
  /listenLocal/.test(localGuardSrc) && /listenLocal\(server/.test(fs.readFileSync(path.join(ROOT, 'electron', 'agent-api.cjs'), 'utf8')));

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

// 7g) 引擎输出行解析 —— 这一段曾经引用过一个根本没定义的常量，
//     真实下载第一行输出就把主进程整个带崩（npm run check 当时照样全绿）。
const progressLine = core.parseEngineLine('download:  45.3%| 1.20MiB/s|00:00:12');
report('progress line parsed into percent/speed/eta',
  progressLine.type === 'progress' && progressLine.percent === '45.3%' && progressLine.speed === '1.20MiB/s' && progressLine.eta === '00:00:12',
  JSON.stringify(progressLine));
const destinationCases = [
  ['[download] Destination: C:\\out\\a.f140.mp4', 'C:\\out\\a.f140.mp4'],
  ['[download] C:\\out\\a.mp4 has already been downloaded', 'C:\\out\\a.mp4'],
  ['[ExtractAudio] Destination: C:\\out\\a.mp3', 'C:\\out\\a.mp3'],
  ['[Merger] Merging formats into "C:\\out\\a.mkv"', 'C:\\out\\a.mkv'],
  ['[download] File was renamed to: C:\\out\\final.mp4', 'C:\\out\\final.mp4'],
];
for (const [line, expected] of destinationCases) {
  const parsed = core.parseEngineLine(line);
  report('destination line -> path', parsed.type === 'destination' && parsed.path === expected, parsed.type + '/' + parsed.path);
}
report('unknown engine line stays a log line', core.parseEngineLine('[debug] Command-line config: [...]').type === 'log');

// 7h) 静态兜底：大写常量必须在本文件里声明过。
// 用没定义的名字在 Node 里要等运行时才炸 —— DESTINATION_PATTERNS 那次就是下载一跑
// 就把主进程带走，而 node --check 全绿。这里做词法扫描（注释/字符串/正则字面量都不算代码）。
const AMBIENT_GLOBALS = new Set(['JSON', 'BUFFER', 'PROMISE', 'REGEXP', 'OBJECT', 'ARRAY', 'SYMBOL', 'PROXY', 'GLOBAL', 'MODULE', 'EXPORT', 'IMPORT']);

function stripCodeOnly(src) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      out += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += "''";
      prevSignificant = "'";
      continue;
    }
    if (ch === '`') {
      i += 1;
      while (i < n && src[i] !== '`') {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '``';
      prevSignificant = '`';
      continue;
    }
    if (ch === '/' && /[=(,:[!&|?{};\s]/.test(prevSignificant || '(')) {
      // 上一个有意义字符说明这里只能是正则字面量
      i += 1;
      let inClass = false;
      while (i < n) {
        const c = src[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;
        i += 1;
      }
      i += 1;
      while (i < n && /[gimsuy]/.test(src[i])) i += 1;
      out += '/rx/';
      prevSignificant = '/';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prevSignificant = ch;
    i += 1;
  }
  return out;
}

function undefinedConstants(file) {
  const code = stripCodeOnly(fs.readFileSync(file, 'utf8'));
  const declared = new Set();
  for (const m of code.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{3,})\b/g)) declared.add(m[1]);
  // 解构与对象字面量里带进来的名字也算"本文件有出处"：const { X } = require(...)
  for (const m of code.matchAll(/[,{]\s*([A-Z][A-Z0-9_]{3,})\s*[,}]/g)) declared.add(m[1]);
  const used = [];
  for (const m of code.matchAll(/(?<![.$\w])([A-Z][A-Z0-9_]{3,})\b/g)) {
    const name = m[1];
    const after = code.slice(m.index + name.length, m.index + name.length + 2);
    if (/^\s*[:=]/.test(after)) continue; // 对象键或赋值目标
    used.push(name);
  }
  return [...new Set(used)].filter((name) => !declared.has(name) && !AMBIENT_GLOBALS.has(name));
}
for (const file of ['electron/engine-core.cjs', 'electron/main.cjs', 'electron/agent-api.cjs', 'electron/local-guard.cjs', 'agent/tools.mjs', 'agent/server.mjs', 'renderer/app.js']) {
  const undeclared = undefinedConstants(path.join(ROOT, file));
  report('no undeclared CONSTANT in ' + file, undeclared.length === 0, undeclared.join(','));
}
// 反向哨兵（变异检查）：这条规则必须真的会红，否则它只是装饰。
const mutantFile = path.join(ROOT, '.check-tmp-mutant.cjs');
fs.writeFileSync(mutantFile, "const A = 1;\n// DESTINATION_PATTERNS 在注释里\nfor (const x of DESTINATION_PATTERNS) { console.log(JSON.stringify(x)); }\n");
try {
  const mutant = undefinedConstants(mutantFile);
  report('undeclared-constant guard actually bites (mutation)', mutant.join(',') === 'DESTINATION_PATTERNS', mutant.join(','));
} finally {
  fs.rmSync(mutantFile, { force: true });
}


report('normalizeMediaUrl rewrites modal_id',
  core.normalizeMediaUrl('https://www.douyin.com/?modal_id=1234567890123') === 'https://www.douyin.com/video/1234567890123');
report('iesdouyin recognized as douyin', core.matchLoginSite('https://www.iesdouyin.com/share/video/1')?.id === 'douyin');
report('unknown host has no site', core.matchLoginSite('https://example.com/x') === null);

// 7b) 引擎判定诚实性：偏好引擎没装时不能说"按设置用了它"
const planForcedMissing = core.planEngine('https://www.bilibili.com/video/BV1',
  { yt_dlp: { available: false }, gallery_dl: { available: true } }, 'yt-dlp');
report('preferred-but-missing engine never becomes primary', planForcedMissing.primary === 'gallery-dl');
report('preferred-but-missing says why', /没有可用/.test(planForcedMissing.chain[0].reason)
  && /不可用/.test(planForcedMissing.executable[0].reason) && /实际改用/.test(planForcedMissing.executable[0].reason),
planForcedMissing.executable[0].reason);
report('plan keeps full chain for display', planForcedMissing.chain.length === 2 && planForcedMissing.executable.length === 1);
report('engine keys normalised (probe uses yt_dlp, plan says yt-dlp)',
  core.planEngine('https://www.bilibili.com/video/BV1', { yt_dlp: { available: true }, gallery_dl: { available: true } }, 'auto')
    .chain.every((step) => step.available === true && !step.unavailable));
const planAllMissing = core.planEngine('https://x.com/a', { yt_dlp: { available: false }, gallery_dl: { available: false } }, 'auto');
report('plan with no engine has empty primary', planAllMissing.primary === '' && planAllMissing.executable.length === 0);

// 7c) 失败出路必须分得开（六类各有下一步）
const kindsOf = (msg, site) => core.classifyParseError(msg, site || null, 'yt-dlp').kind;
report('fail: proxy blocked', kindsOf('ERROR: unable to connect to proxy: 407 Proxy Authentication Required') === 'proxy');
report('fail: site changed', kindsOf('ERROR: [bilibili] Unable to extract json data; please report this issue on https://github.com/yt-dlp/yt-dlp') === 'unsupported_site');
report('fail: site changed (known site)', kindsOf('ERROR: Unable to extract title; please report this issue', core.LOGIN_SITES.bilibili) === 'site_changed');
report('fail: link gone', kindsOf('ERROR: [tiktok] The requested page has a HTTP Error 404') === 'link_gone');
report('fail: not a content page', kindsOf('ERROR: Unsupported URL: https://www.bilibili.com/?') === 'unsupported_url');
report('fail: engine missing', kindsOf('ERROR: 找不到引擎可执行文件：yt-dlp') === 'engine_missing');
report('fail: every kind carries remedies', ['proxy', 'site_changed', 'link_gone', 'unsupported_url', 'engine_missing']
  .every((kind) => {
    const sample = {
      proxy: 'cannot connect to proxy 407',
      site_changed: 'please report this issue',
      link_gone: 'HTTP Error 404 Not Found',
      unsupported_url: 'Unsupported URL',
      engine_missing: '找不到引擎',
    }[kind];
    const diag = core.classifyParseError(sample, kind === 'site_changed' ? core.LOGIN_SITES.bilibili : null, 'yt-dlp');
    return diag.kind === kind && diag.remedies.length >= 2 && diag.remedies.every((r) => r.label && r.action);
  }));
const networkDiag = core.classifyParseError('Unable to download webpage: timed out', null, 'yt-dlp');
report('fail: plain timeout stays network', networkDiag.kind === 'network', networkDiag.kind);

// 7d) 未完成分片：看得见、只删引擎临时文件、不碰成品
const tmpScan = path.join(ROOT, '.check-tmp-parts');
fs.rmSync(tmpScan, { recursive: true, force: true });
try {
  fs.mkdirSync(path.join(tmpScan, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tmpScan, 'a.mp4.part'), 'x'.repeat(120));
  fs.writeFileSync(path.join(tmpScan, 'sub', 'b.ytdl'), 'yy');
  fs.writeFileSync(path.join(tmpScan, 'keep.mp4'), 'done');
  const scan = core.scanEngineTempFiles(tmpScan);
  report('temp scan counts only engine temp files', scan.count === 2 && scan.bytes === 122, `count=${scan.count} bytes=${scan.bytes}`);
  const cleaned = core.removeEngineTempFiles(tmpScan);
  report('temp clean removes only temp files', cleaned.count === 2
    && fs.existsSync(path.join(tmpScan, 'keep.mp4'))
    && !fs.existsSync(path.join(tmpScan, 'a.mp4.part')));
  report('temp scan rejects relative path', core.scanEngineTempFiles('relative/dir').valid === false);
  report('temp scan on missing dir is honest', core.scanEngineTempFiles(path.join(tmpScan, 'nope')).count === 0);
} finally {
  fs.rmSync(tmpScan, { recursive: true, force: true });
}

const dirStatus = core.enginesDirStatus(path.join(ROOT, 'no-such-engine-dir'));
report('stale engines dir reported honestly', dirStatus.configured && !dirStatus.exists && /不存在/.test(dirStatus.note));
const dirStatusReal = core.enginesDirStatus(path.join(ROOT, 'electron'));
report('existing engines dir without tools listed', dirStatusReal.exists && dirStatusReal.engines.length === 0);

const catalog = core.siteCatalog();
report('site catalog is the single source for the UI', catalog.length === 5
  && catalog.every((s) => s.id && s.label && Array.isArray(s.domains) && s.domains.length && s.content_kind));
report('site catalog carries no cookie values', !/sessionid_ss=|SESSDATA=/.test(JSON.stringify(catalog)));

// 7e) 界面不许再抄一份站点域名（抄第二遍就会和核心分叉）
report('renderer has no duplicated site domain table', !/douyin\.com/.test(appJs) && !/xiaohongshu\.com/.test(appJs));
report('renderer reads site list from main', /window\.qingying\.sitesList\(\)/.test(appJs));
report('renderer explains part-file resume', /\.part/.test(appJs) && /接着下/.test(appJs));
report('renderer shows engine decision chain', /engine_chain/.test(appJs) && /renderChainList/.test(appJs));
report('renderer keeps invalid template visible', /没有保存：/.test(appJs));

// 7f) 队列与降级：主进程里的真实接线
const galleryCall = (main.match(/runGalleryDlDownload\(\{[\s\S]{0,400}?\}, hooks\)/g) || []).filter((block) => /engineOptions/.test(block));
report('gallery-dl download gets engine search options', galleryCall.length >= 1, `blocks=${galleryCall.length}`);
report('queue pump skips tasks waiting for retry backoff', /status === 'queued' && !task\.timer/.test(main));
report('auth snapshot declares it stores no cookie values', /cookie_values_stored: false/.test(main));
report('removed task never re-writes history', /if \(task\.removed\) return;/.test(main));
const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles.css'), 'utf8');
report('every queue status has a colour', ['done', 'failed', 'paused', 'cancelled', 'downloading', 'queued']
  .every((status) => css.includes(`.task-row.status-${status}`)));
report('status colour token exists and is reused', /--warning: #ffcb6b/.test(css) && /var\(--warning\)/.test(css));
report('no emoji used as icons', !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html + appJs + css));
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
report('gitignore covers shortcuts and installer copy', /\*\.lnk/.test(gitignore) && /\/清影下载器-安装包\//.test(gitignore));
report('agent keeps 8 tools (contract window is 4-8)', (agentTools.match(/name: 'qingying\./g) || []).length === 8,
  `count=${(agentTools.match(/name: 'qingying\./g) || []).length}`);
report('agent reports reason text for failures', /function reasonText/.test(agentTools) && /REASON_TEXT/.test(agentTools));

// 8) 设置/历史读写只落在给定目录
const tmp = path.join(ROOT, '.check-tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
try {
  const saved = core.writeSettings(tmp, { outputDir: 'C:/x', autoRetry: 99, concurrency: 0 });
  report('settings clamped', saved.autoRetry === 5 && saved.concurrency === 1);
  const { mock } = require('node:test');
  const rename = mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EPERM' }); });
  let writeFailed = false;
  try { core.writeSettings(tmp, { concurrency: 3 }); } catch { writeFailed = true; } finally { rename.mock.restore(); }
  report('failed settings replacement preserves previous value', writeFailed && core.readSettings(tmp).concurrency === 1);
  report('failed settings replacement removes temporary file', !fs.existsSync(core.dataPaths(tmp).settings + '.tmp'));
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
