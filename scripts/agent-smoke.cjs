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

let checks = 0;
let failures = 0;
function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + ascii(detail) : ''}`);
}

async function get(route) {
  const res = await fetch(BASE + route, { signal: AbortSignal.timeout(8000) });
  return { status: res.status, json: await res.json() };
}

async function call(tool, input) {
  const res = await await fetch(BASE + '/api/agent/tool', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, input }),
    signal: AbortSignal.timeout(240000),
  });
  return { status: res.status, json: await res.json() };
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
      env: { ...process.env, AGENT_DEFAULT_BASE: BASE },
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
  const server = spawn(LAUNCH.command, LAUNCH.args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
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
