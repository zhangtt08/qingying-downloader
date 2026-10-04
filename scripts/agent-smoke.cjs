'use strict';
// Agent 接口自检（npm run agent:check）：起真实服务，打真实工具，跑 MCP 三条握手。
// 需要出网的用例默认跳过，设 QY_SMOKE_NETWORK=1 才跑（并用 HTTPS_PROXY 指到本机代理）。
// 控制台按 GBK，所以这里只打印 ASCII，中文摘要一律转义。
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const LAUNCH = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent', 'launch.json'), 'utf8'));
const PORT = LAUNCH.ready_port;
const BASE = 'http://127.0.0.1:' + PORT;
const ascii = (value) => String(value).replace(/[^ -~]/g, '?');
// 本机令牌：写请求必须带（判据在 electron/local-guard.cjs）。这里用一次性测试令牌，
// 走环境变量，避免把测试值写进用户真实的 app-data。
const TEST_TOKEN = 'smoke' + Date.now().toString(16) + Math.random().toString(16).slice(2, 10);

let checks = 0;
let failures = 0;
function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + ascii(detail) : ''}`);
}

async function get(route) {
  const res = await fetch(BASE + route, { signal: AbortSignal.timeout(8000) });
  return { status: res.status, json: await res.json(), headers: Object.fromEntries(res.headers.entries()) };
}

async function call(tool, input) {
  const res = await fetch(BASE + '/api/agent/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-qingying-token': TEST_TOKEN },
    body: JSON.stringify({ tool, input }),
    signal: AbortSignal.timeout(240000),
  });
  return { status: res.status, json: await res.json(), headers: Object.fromEntries(res.headers.entries()) };
}

/** 直接打一个自定义 Host / Origin 的请求，看守卫认不认（fetch 不许改 Host，得用 node:http） */
function rawRequest(options, body) {
  return new Promise((resolve, reject) => {
    const http = require('node:http');
    const req = http.request({ host: '127.0.0.1', port: PORT, ...options }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('raw request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(limit = 60) {
  for (let i = 0; i < limit; i += 1) {
    try {
      const res = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(800) });
      if (res.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function mcpHandshake() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'agent', 'mcp-server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_DEFAULT_BASE: BASE, QINGYING_API_TOKEN: TEST_TOKEN },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    const messages = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qingying.engines', arguments: {} } }),
    ];
    child.stdin.write(messages.join('\n') + '\n');
    child.stdin.end();
    child.on('close', () => {
      const parsed = out.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      resolve({ parsed, err });
    });
    child.on('error', reject);
    setTimeout(() => { child.kill(); reject(new Error('mcp timeout')); }, 60000);
  });
}

(async () => {
  // 一次性 app-data：自检绝不碰用户真实的设置/历史/登录态导出。
  const tmpData = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'qy-agent-smoke-'));
  const endpointFile = path.join(tmpData, '.endpoint');
  const server = spawn(LAUNCH.command, LAUNCH.args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      QINGYING_API_TOKEN: TEST_TOKEN,
      QINGYING_DATA_DIR: tmpData,
      AGENT_ENDPOINT_FILE: endpointFile,
    },
  });
  let serverLog = '';
  server.stdout.on('data', (c) => { serverLog += c.toString('utf8'); });
  server.stderr.on('data', (c) => { serverLog += c.toString('utf8'); });

  try {
    const healthy = await waitForHealth();
    report('server starts on port ' + PORT, healthy, serverLog);
    if (!healthy) return;

    const health = await get('/api/health');
    report('GET /api/health envelope', health.status === 200 && health.json.ok === true
      && health.json.data.project === 'qingying' && health.json.data.agent_api === 1,
    JSON.stringify(health.json));
    report('health reports its own guard instead of a doc claim', health.json.data.guard
      && health.json.data.guard.token_required === true && health.json.data.guard.token_available === true
      && health.json.data.guard.token_source === 'env'
      && /127\.0\.0\.1:/.test(health.json.data.guard.host_allowlist),
    JSON.stringify(health.json.data.guard));
    report('health reports the desktop api real state (honest when absent)', health.json.data.desktop_api
      && typeof health.json.data.desktop_api.listening === 'boolean',
    JSON.stringify(health.json.data.desktop_api));
    report('no wildcard CORS anywhere on the agent api', !/\*/.test(String(health.headers['access-control-allow-origin'] || 'absent'))
      && !health.headers['access-control-allow-origin'], JSON.stringify(health.headers));

    // ── 守卫四条：伪造 Host / 外部 Origin / 缺令牌 / 只读不带令牌也能过 ──
    const forgedHost = await rawRequest({
      method: 'GET', path: '/api/health', headers: { Host: 'attacker.example.com' },
    });
    report('forged Host -> 403 HOST_NOT_ALLOWED', forgedHost.status === 403
      && forgedHost.json?.error?.code === 'HOST_NOT_ALLOWED', JSON.stringify(forgedHost.json?.error));
    const evilOrigin = await rawRequest({
      method: 'POST', path: '/api/agent/tool',
      headers: { host: '127.0.0.1:' + PORT, origin: 'https://evil.example.com', 'content-type': 'application/json', 'x-qingying-token': TEST_TOKEN },
      body: JSON.stringify({ tool: 'qingying.engines', input: {} }),
    }, JSON.stringify({ tool: 'qingying.engines', input: {} }));
    report('foreign Origin on a POST -> 403 ORIGIN_NOT_ALLOWED', evilOrigin.status === 403
      && evilOrigin.json?.error?.code === 'ORIGIN_NOT_ALLOWED', JSON.stringify(evilOrigin.json?.error));
    const noToken = await rawRequest({
      method: 'POST', path: '/api/agent/tool',
      headers: { host: '127.0.0.1:' + PORT, 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'qingying.engines', input: {} }),
    }, JSON.stringify({ tool: 'qingying.engines', input: {} }));
    report('POST without token -> 401 TOKEN_REQUIRED', noToken.status === 401
      && noToken.json?.error?.code === 'TOKEN_REQUIRED', JSON.stringify(noToken.json?.error));
    const wrongToken = await rawRequest({
      method: 'POST', path: '/api/agent/tool',
      headers: { host: '127.0.0.1:' + PORT, 'content-type': 'application/json', 'x-qingying-token': 'obviously-wrong' },
      body: JSON.stringify({ tool: 'qingying.engines', input: {} }),
    }, JSON.stringify({ tool: 'qingying.engines', input: {} }));
    report('POST with wrong token -> 401', wrongToken.status === 401, JSON.stringify(wrongToken.json?.error));
    const getNeedsNoToken = await rawRequest({
      method: 'GET', path: '/api/agent/tools', headers: { host: '127.0.0.1:' + PORT },
    });
    report('GET stays usable without a token (read-only path works)', getNeedsNoToken.status === 200
      && Array.isArray(getNeedsNoToken.json?.data), 'status=' + getNeedsNoToken.status);
    report('guard denials carry a JSON body and no ACAO header', forgedHost.json?.ok === false
      && !forgedHost.headers['access-control-allow-origin'], JSON.stringify(forgedHost.headers));

    const tools = await get('/api/agent/tools');
    const names = (tools.json.data || []).map((t) => t.name);
    report('GET /api/agent/tools has 4-8 qingying.* tools',
      names.length >= 4 && names.length <= 8 && names.every((n) => n.startsWith('qingying.')), names.join(','));
    report('tools declare risk + schema', (tools.json.data || [])
      .every((t) => ['read', 'write', 'exec'].includes(t.risk) && t.input_schema && t.input_schema.type === 'object'));
    report('download tool is risk=exec', (tools.json.data || [])
      .find((t) => t.name === 'qingying.download')?.risk === 'exec');

    const manifest = await get('/api/agent/manifest');
    report('GET /api/agent/manifest', manifest.status === 200 && manifest.json.data.base_url === BASE, manifest.json.data.base_url);

    const engines = await call('qingying.engines', {});
    const records = engines.json.data?.engines || {};
    report('qingying.engines answers with real version or honest miss',
      engines.json.ok === true && ['yt-dlp', 'gallery-dl', 'ffmpeg'].every((name) => {
        const key = { 'yt-dlp': 'yt_dlp', 'gallery-dl': 'gallery_dl', ffmpeg: 'ffmpeg' }[name];
        const record = records[key];
        if (!record) return false;
        return record.available ? /^\S+$/.test(record.version) : record.available === false;
      }),
      JSON.stringify(Object.entries(records).map(([k, v]) => `${k}=${v.available}/${v.version || v.error}/${v.source}`)));
    const yt = records.yt_dlp;
    report('yt-dlp reachable on this machine (informational)', Boolean(yt?.available),
      yt?.available ? 'version ' + yt.version : 'NOT INSTALLED - parse/download will report honestly');

    const badInput = await call('qingying.parse', {});
    report('missing required -> bad_input + 400', badInput.status === 400 && badInput.json.error?.code === 'bad_input',
      JSON.stringify(badInput.json.error));

    const unknown = await call('qingying.nope', {});
    report('unknown tool -> available list', unknown.json.ok === false
      && Array.isArray(unknown.json.error?.available) && unknown.json.error.available.length >= 4,
      JSON.stringify(unknown.json.error?.available));

    const noConfirm = await call('qingying.download', { url: 'https://example.com/x' });
    report('download without confirm is refused', noConfirm.json.ok === false
      && noConfirm.json.error?.code === 'confirm_required', JSON.stringify(noConfirm.json.error));

    const auth = await call('qingying.auth_status', {});
    const dump = JSON.stringify(auth.json.data);
    report('auth_status returns 5 sites, no cookie values',
      (auth.json.data?.sites || []).length === 5 && !/"value"/.test(dump) && !/set-cookie/i.test(dump));

    const settings = await call('qingying.settings', {});
    report('settings readable', settings.json.ok === true && Boolean(settings.json.data?.data_dir),
      settings.json.data?.data_dir);

    const badTemplate = await call('qingying.settings_set', { filename_template: '%(evil)s.%(ext)s' });
    report('bad filename template rejected', badTemplate.json.ok === false
      && badTemplate.json.error?.code === 'bad_input', JSON.stringify(badTemplate.json.error));

    // ── 下载目录边界（outputDir 不再能指到磁盘任意位置）──
    const outside = path.resolve(require('node:os').tmpdir(), 'qy-outside-root-' + Date.now().toString(36));
    const inside = path.join(tmpData, 'downloads', 'allowed-sub');
    const noRoot = await call('qingying.download', { url: 'https://example.com/v', confirm: true, output_dir: outside });
    report('no designated root -> refused before writing, actionable code', noRoot.json.ok === false
      && noRoot.json.error?.code === 'no_download_root' && /保存位置/.test(noRoot.json.error?.message || ''),
    JSON.stringify(noRoot.json.error));
    report('refusal created nothing on disk', !fs.existsSync(outside), outside);

    const setRoot = await call('qingying.settings_set', { output_dir: path.join(tmpData, 'downloads') });
    report('designated download root accepted (absolute)', setRoot.json.ok === true
      && (setRoot.json.data?.settings?.outputDir || '').length > 0, JSON.stringify(setRoot.json.data?.settings?.outputDir));
    const rootsSeen = await call('qingying.settings', {});
    report('settings report the download roots the api will honour', (rootsSeen.json.data?.download_roots || []).length >= 1,
      JSON.stringify(rootsSeen.json.data?.download_roots));

    const outsideAfterRoot = await call('qingying.download', { url: 'https://example.com/v', confirm: true, output_dir: outside });
    report('output_dir outside the root -> 400 + refused, nothing written', outsideAfterRoot.status === 400
      && outsideAfterRoot.json.error?.code === 'output_dir_outside_root' && !fs.existsSync(outside),
    JSON.stringify(outsideAfterRoot.json.error));
    const relativeDir = await call('qingying.download', { url: 'https://example.com/v', confirm: true, output_dir: 'relative/sub' });
    report('relative output_dir refused', relativeDir.json.error?.code === 'output_dir_not_absolute',
      JSON.stringify(relativeDir.json.error));

    // 合法路径必须仍然走得下去：目录闸门放行后才轮到解析/引擎，所以这里的失败原因
    // 一定不是 output_dir 那几条（本机默认不联网，通常是 parse_failed）。
    const insideDir = await call('qingying.download', { url: 'https://example.com/v', confirm: true, output_dir: inside });
    const insideCode = insideDir.json.error?.code || '';
    report('legit output_dir inside the root passes the gate', !/^output_dir|^no_download_root/.test(insideCode)
      || insideDir.json.ok === true, JSON.stringify({ status: insideDir.status, code: insideCode }));
    report('legit output_dir got created under the root', fs.existsSync(inside) && fs.statSync(inside).isDirectory(), inside);

    const mcp = await mcpHandshake();
    const ids = mcp.parsed.map((m) => m.id).filter(Boolean);
    report('MCP initialize answered', mcp.parsed.some((m) => m.id === 1 && m.result?.protocolVersion), ids.join(','));
    report('MCP tools/list answered', mcp.parsed.some((m) => m.id === 2 && Array.isArray(m.result?.tools)
      && m.result.tools.length >= 4), (mcp.parsed.find((m) => m.id === 2)?.result?.tools || []).map((t) => t.name).join(','));
    const call3 = mcp.parsed.find((m) => m.id === 3);
    report('MCP tools/call answered with data', Boolean(call3?.result?.content?.[0]?.text) && call3.result.isError === false,
      call3?.result?.content?.[0]?.text?.slice(0, 120));

    if (process.env.QY_SMOKE_NETWORK === '1') {
      const url = process.env.QY_SMOKE_URL || 'https://download.samplelib.com/mp4/sample-5s.mp4';
      const parsed = await call('qingying.parse', { url });
      report('network parse on ' + new URL(url).host, parsed.json.ok === true
        && parsed.json.data?.ok !== false && Number(parsed.json.data?.counts?.videos) >= 0,
      JSON.stringify(parsed.json.data?.ok === false ? parsed.json.data : { engine: parsed.json.data?.engine, counts: parsed.json.data?.counts }));

      const dl = await call('qingying.download', { url, confirm: true, mode: 'video' });
      const files = dl.json.data?.files || [];
      const onDisk = files.every((f) => fs.existsSync(f.path) && fs.statSync(f.path).size === f.bytes);
      report('network download lands on disk', dl.json.ok === true && files.length > 0 && onDisk,
        JSON.stringify({ ok: dl.json.ok, files: files.map((f) => f.path + ':' + f.bytes), bytes: dl.json.data?.bytes, error: dl.json.error?.message }));

      const tasks = await call('qingying.tasks', {});
      report('tasks registry reports the run', (tasks.json.data?.tasks || []).length > 0,
        JSON.stringify((tasks.json.data?.tasks || [])[0] || {}));

      const history = await call('qingying.history', { limit: 3 });
      report('history recorded the run', (history.json.data?.items || []).length > 0,
        JSON.stringify((history.json.data?.items || [])[0]?.status));
    } else {
      console.log('SKIP  network cases (set QY_SMOKE_NETWORK=1 to run parse/download against a real URL)');
    }
  } finally {
    server.kill();
  }

  console.log(`\n${checks - failures}/${checks} agent checks passed`);
  process.exit(failures ? 1 : 0);
})().catch((error) => {
  console.log('SCRIPT FAIL: ' + error.message);
  process.exit(1);
});
