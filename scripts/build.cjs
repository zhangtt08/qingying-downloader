'use strict';
// 唯一真实的构建入口（npm run build）。
// 以前仓库里"如何打包"只有两句从别人机器上 asar extract/pack 的硬编码路径，
// 既跑不通也不可复现；现在这里做四件事，每一件都会把结果如实打印出来：
//   1) 预检：所有源码 node --check 过一遍，package.json 的入口字段在不在；
//   2) dist/app.asar —— 用 @electron/asar 按白名单打包（等价于以前手搓的 npx asar pack）；
//   3) dist/win-unpacked —— 调 electron-builder --win --dir 出可直接双击运行的目录；
//   4) 验收产物：asar 里该有的文件在不在、exe 在不在、引擎二进制带没带上（带不上就明说）。
// 加 --installer 再顺带跑 NSIS 安装包（npm run dist 是同一条命令）。
// 控制台按 GBK，所以这里只打印 ASCII。
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const APP_NAME = '清影下载器';
const ENGINE_EXES = ['yt-dlp.exe', 'gallery-dl.exe', 'ffmpeg.exe'];
const WANT = ['electron/main.cjs', 'electron/local-guard.cjs', 'electron/preload.cjs', 'electron/engine-core.cjs', 'electron/agent-api.cjs', 'renderer/index.html', 'renderer/app.js', 'agent/server.mjs', 'agent/tools.mjs', 'agent/mcp-server.mjs'];

let failures = 0;
function report(name, ok, detail) {
  failures += ok ? 0 : 1;
  const ascii = (value) => String(value === undefined ? '' : value).replace(/[^ -~]/g, '?');
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + ascii(detail) : ''}`);
}
function info(line) {
  console.log('      ' + String(line).replace(/[^ -~]/g, '?'));
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// ── 1) 预检 ───────────────────────────────────────────────────────────────
report('package.json main points at electron/main.cjs', pkg.main === 'electron/main.cjs', pkg.main);
report('electron runtime installed', fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist'))
  || fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt')),
  fs.existsSync(path.join(ROOT, 'node_modules', 'electron')) ? 'package present' : 'run npm install first');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) {
  console.log('FAIL  需要先 npm install（electron 运行时不在本地，构建无法继续）');
  process.exit(1);
}
const electronVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
info(`electron ${electronVersion} · app ${pkg.name} ${pkg.version}`);

const sources = WANT.filter((f) => /\.(cjs|mjs|js)$/.test(f)).map((f) => path.join(ROOT, f));
for (const file of sources) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    report('syntax ' + path.relative(ROOT, file), true);
  } catch (error) {
    report('syntax ' + path.relative(ROOT, file), false, String(error.stderr || error.message).split('\n').slice(0, 2).join(' '));
  }
}
for (const file of WANT.filter((f) => /\.html$/.test(f))) {
  report('source file present ' + file, fs.existsSync(path.join(ROOT, file)));
}

// ── 2) dist/app.asar ──────────────────────────────────────────────────────
const asar = require('@electron/asar');
fs.mkdirSync(DIST, { recursive: true });
const staging = path.join(DIST, 'app-source');
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const dir of ['electron', 'renderer', 'agent']) {
  fs.cpSync(path.join(ROOT, dir), path.join(staging, dir), {
    recursive: true,
    filter: (src) => !/[\\/]\.endpoint$|[.]log$|[.]tmp$/.test(src),
  });
}
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(staging, 'package.json'));
const asarPath = path.join(DIST, 'app.asar');
fs.rmSync(asarPath, { force: true });
// 用 asar 的 CLI（同步）而不是 await 一个 Promise —— 这个脚本从头到尾是顺序执行的。
const asarCli = path.join(ROOT, 'node_modules', '@electron', 'asar', 'bin', 'asar.mjs');
try {
  execFileSync(process.execPath, [asarCli, 'pack', staging, asarPath], { stdio: 'pipe' });
} catch (error) {
  report('asar pack', false, String(error.stderr || error.message).split('\n').slice(0, 3).join(' '));
}
fs.rmSync(staging, { recursive: true, force: true });
report('dist/app.asar created', fs.existsSync(asarPath) && fs.statSync(asarPath).size > 10000,
  fs.existsSync(asarPath) ? fs.statSync(asarPath).size + ' bytes' : 'missing');
const listed = asar.listPackage(asarPath).map((entry) => entry.replace(/^[\\/]+/, '').split('\\').join('/'));
for (const file of WANT) {
  report('asar contains ' + file, listed.includes(file), '');
}
report('asar excludes the runtime endpoint file', !listed.some((entry) => entry.endsWith('.endpoint')), '');

// ── 3) electron-builder：dir（可选 nsis）──────────────────────────────────
function runBuilder(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 1800000,
  });
  const out = String(result.stdout || '') + String(result.stderr || '');
  const tail = out.split(/\r?\n/).filter(Boolean).slice(-6);
  tail.forEach((line) => info(line));
  return { ok: result.status === 0, status: result.status, out };
}
const dirBuild = runBuilder(['--win', '--dir']);
report('electron-builder --win --dir', dirBuild.ok, dirBuild.ok ? '' : 'exit ' + dirBuild.status);

const outDir = path.join(DIST, 'win-unpacked');
const exePath = path.join(outDir, APP_NAME + '.exe');
report('dir shape has the renamed executable', fs.existsSync(exePath), path.relative(ROOT, exePath));
const packedAsar = path.join(outDir, 'resources', 'app.asar');
report('dir shape carries resources/app.asar', fs.existsSync(packedAsar));
if (fs.existsSync(packedAsar)) {
  const packedList = asar.listPackage(packedAsar).map((e) => e.replace(/^[\\/]+/, '').split('\\').join('/'));
  report('packed asar has the guard module', packedList.includes('electron/local-guard.cjs'));
  report('packed asar has the agent surfaces', packedList.includes('agent/server.mjs') && packedList.includes('electron/agent-api.cjs'));
  report('packed asar has no cookie/history/settings data',
    !packedList.some((entry) => /auth-state\.json|history\.json|settings\.json|cookies\//.test(entry)), '');
  // 产物里的代码必须与仓库里的逐字节相同 —— 否则"构建可复现"这句话只是愿望。
  for (const file of ['electron/main.cjs', 'electron/local-guard.cjs', 'electron/engine-core.cjs', 'agent/server.mjs']) {
    const shipped = asar.extractFile(packedAsar, file);
    const onDisk = fs.readFileSync(path.join(ROOT, file));
    report('shipped bytes identical to source: ' + file, Boolean(shipped) && shipped.equals(onDisk),
      shipped ? shipped.length + '/' + onDisk.length : 'missing from asar');
  }
}

// 引擎二进制不在仓库里（/resources/ 被 gitignore），所以这一步要么带上、要么明说没带。
const enginesHere = ENGINE_EXES.filter((name) => fs.existsSync(path.join(ROOT, 'resources', 'bin', name)));
const targetBin = path.join(outDir, 'resources', 'bin');
if (enginesHere.length) {
  fs.mkdirSync(targetBin, { recursive: true });
  for (const name of enginesHere) fs.copyFileSync(path.join(ROOT, 'resources', 'bin', name), path.join(targetBin, name));
  report('engine binaries bundled into resources/bin', ENGINE_EXES.every((n) => fs.existsSync(path.join(targetBin, n))), enginesHere.join(','));
} else {
  info('INFO  engines not bundled: resources/bin is empty (yt-dlp/gallery-dl/ffmpeg are gitignored).');
  info('INFO  the packaged app reports them as 未安装 until you put the pinned exes there or on PATH.');
}

// ── 4) 安装包（可选）──────────────────────────────────────────────────────
let installer = null;
if (process.argv.includes('--installer')) {
  const nsis = runBuilder(['--win', 'nsis']);
  report('electron-builder --win nsis', nsis.ok, nsis.ok ? '' : 'exit ' + nsis.status);
  const artifact = path.join(DIST, `${pkg.name}-${pkg.version}-win-x64.exe`);
  installer = fs.existsSync(artifact) ? artifact : '';
  report('installer artifact present', Boolean(installer), installer || path.basename(artifact));
}

const buildInfo = [
  `app         ${pkg.name} ${pkg.version}`,
  `electron    ${electronVersion}`,
  `produced    ${new Date().toISOString()}`,
  `dir shape   ${path.relative(ROOT, outDir)} (run ${APP_NAME}.exe directly; no installer needed)`,
  `asar        ${path.relative(ROOT, asarPath)} (drop-in replacement for resources/app.asar)`,
  `installer   ${installer ? path.relative(ROOT, installer) : 'not built this run (add --installer, or npm run dist)'}`,
  `engines     ${enginesHere.length ? enginesHere.join(', ') : 'NOT bundled - place yt-dlp.exe/gallery-dl.exe/ffmpeg.exe in resources/bin or on PATH'}`,
  'note        no user data (settings/history/cookies) is part of any artifact',
].join('\n');
fs.writeFileSync(path.join(DIST, 'BUILD-INFO.txt'), buildInfo + '\n', 'utf8');
console.log('\n' + buildInfo.replace(/[^ -~]/g, '?'));
console.log(failures ? `\nbuild FAILED: ${failures} step(s)` : '\nbuild OK');
process.exit(failures ? 1 : 0);
