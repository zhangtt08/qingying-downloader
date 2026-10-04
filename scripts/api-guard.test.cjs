'use strict';
// 本机接口守卫自检（npm run verify 的一部分）。
// 覆盖两条接口：应用内 REST(默认 8392) 与独立 Agent API(默认 8793)。
// 全部在临时 app-data + 本机回环随机端口上跑，不碰用户真实的设置/历史/登录态，也不出网。
// 控制台按 GBK，所以打印一律转 ASCII。
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const core = require(path.join(ROOT, 'electron', 'engine-core.cjs'));
const guard = require(path.join(ROOT, 'electron', 'local-guard.cjs'));
const { createAgentApiServer } = require(path.join(ROOT, 'electron', 'agent-api.cjs'));

const ascii = (value) => String(value === undefined ? '' : value).replace(/[^ -~]/g, '?');
let checks = 0;
let failures = 0;
function report(name, ok, detail) {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ' :: ' + ascii(detail) : ''}`);
}
function section(title) {
  console.log('\n-- ' + title + ' ' + '-'.repeat(Math.max(0, 58 - title.length)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** 手写请求：fetch 不给伪造 Host/Origin 的机会，而那两个正是这轮要挡的东西。 */
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', ...options }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, headers: res.headers, text });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'qy-guard-'));
}

/** MCP 握手：只喂 AGENT_BASE_URL，不带令牌环境变量 —— 让桥自己去读那份 0600 文件。 */
function mcpCall(port, dataDir) {
  return new Promise((resolve) => {
    const env = { ...process.env, AGENT_BASE_URL: 'http://127.0.0.1:' + port, QINGYING_DATA_DIR: dataDir };
    delete env.QINGYING_API_TOKEN;
    const child = spawn(process.execPath, [path.join(ROOT, 'agent', 'mcp-server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let out = '';
    let errText = '';
    child.stdout.on('data', (c) => { out += c.toString('utf8'); });
    child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
    const messages = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qingying.engines', arguments: {} } }),
    ];
    child.stdin.write(messages.join('\n') + '\n');
    child.stdin.end();
    const timer = setTimeout(() => {
      child.kill();
      resolve({ parsed: [], callResult: null, callText: '', raw: out, err: errText, timedOut: true });
    }, 60000);
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = out.split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const call3 = parsed.find((m) => m.id === 3);
      resolve({
        parsed,
        callResult: call3?.result,
        callText: call3?.result?.content?.[0]?.text || '',
        raw: out,
        err: errText,
        timedOut: false,
      });
    });
  });
}

async function main() {
  // ── 1) 判据表（纯函数，最快也最容易看错的一层）──────────────────────────
  section('guard decision table');
  const PORT = 8392;
  const hostCases = [
    ['127.0.0.1:8392', true],
    ['localhost:8392', true],
    ['[::1]:8392', true],
    ['127.0.0.1:8393', false],
    ['attacker.example.com:8392', false],
    ['127.0.0.1.evil.com:8392', false],
    ['evil.com:8392', false],
    ['127.0.0.1', false],
    ['', false],
  ];
  for (const [host, expected] of hostCases) {
    report('hostAllowed ' + (host || '(empty)') + ' = ' + expected, guard.hostAllowed(host, PORT) === expected);
  }
  const originCases = [
    [undefined, true],
    ['', true],
    ['http://127.0.0.1:5173', true],
    ['http://localhost:3000', true],
    ['https://evil.example.com', false],
    ['http://evil.example.com:8392', false],
    ['http://127.0.0.1.evil.com', false],
    ['null', false],
    ['file://', false],
    ['not a url', false],
  ];
  for (const [origin, expected] of originCases) {
    report('originAllowed ' + (origin === undefined ? '(absent)' : origin) + ' = ' + expected,
      guard.originAllowed(origin) === expected);
  }
  report('token compare is constant time + exact',
    guard.tokenMatches('abcdef0123456789', 'abcdef0123456789') === true
    && guard.tokenMatches('abcdef0123456788', 'abcdef0123456789') === false
    && guard.tokenMatches('', 'abcdef0123456789') === false
    && guard.tokenMatches('x', '') === false);

  // 关键一条：Origin 不与"请求自己的 Host"比 —— DNS rebinding 时两者自然相等。
  const rebound = guard.checkLocalGuard(
    { headers: { host: 'attacker.test:' + PORT, origin: 'http://attacker.test:' + PORT }, method: 'POST' },
    { port: PORT, token: 't' },
  );
  report('Host vs Origin equality is NOT accepted (DNS rebinding)',
    rebound.ok === false && rebound.code === 'HOST_NOT_ALLOWED', JSON.stringify(rebound.code));

  // ── 2) 令牌持久化（0600，per-user app-data）─────────────────────────────
  section('token file');
  const tokenDir = tmpDir('qy-token-');
  const tokenFile = core.dataPaths(tokenDir).apiToken;
  const writeCalls = [];
  const realWrite = fs.writeFileSync;
  const realChmod = fs.chmodSync;
  fs.writeFileSync = function (file, data, options) {
    writeCalls.push({ mode: options && options.mode });
    return realWrite.call(fs, file, data, options);
  };
  fs.chmodSync = function (file, mode) {
    writeCalls.push({ chmod: mode });
    return realChmod.call(fs, file, mode);
  };
  let first;
  let second;
  try {
    first = guard.resolveApiToken({ tokenFile, env: {} });
    second = guard.resolveApiToken({ tokenFile, env: {} });
  } finally {
    fs.writeFileSync = realWrite;
    fs.chmodSync = realChmod;
  }
  report('token created on first use, stable afterwards',
    /^[0-9a-f]{32,128}$/.test(first.token) && second.token === first.token && second.source === 'file',
    first.source + '/' + second.source);
  report('token file requested as 0600',
    writeCalls.some((c) => c.mode === 0o600) && writeCalls.some((c) => c.chmod === 0o600),
    JSON.stringify(writeCalls.map((c) => String((c.mode === undefined ? c.chmod : c.mode).toString(8)))));
  if (process.platform !== 'win32') {
    report('token file mode on disk is 0600', (fs.statSync(tokenFile).mode & 0o777) === 0o600,
      (fs.statSync(tokenFile).mode & 0o777).toString(8));
  }
  report('token lives in the per-user app-data path', tokenFile === path.join(tokenDir, 'agent-api.token'), tokenFile);
  report('token value never appears in the returned metadata',
    !JSON.stringify({ source: first.source, file: first.file, error: first.error }).includes(first.token));
  const envToken = guard.resolveApiToken({ tokenFile, env: { QINGYING_API_TOKEN: 'envtoken0123456789abcdef' } });
  report('env token wins over the file', envToken.token === 'envtoken0123456789abcdef' && envToken.source === 'env');

  // 令牌写不出来 = fail-closed，不是放开。（父路径是一个普通文件 → 任何平台都建不出来，
  // 也不用往 C 盘根目录写东西。）
  const blocker = path.join(tokenDir, 'a-regular-file');
  realWrite(blocker, 'not a directory', { encoding: 'utf8' });
  const unwritable = guard.resolveApiToken({ tokenFile: path.join(blocker, 'agent-api.token'), env: {} });
  report('unwritable token file yields no token', unwritable.token === '' && Boolean(unwritable.error), unwritable.error);
  report('unwritable token file made no token on disk', !fs.existsSync(path.join(blocker, 'agent-api.token')));
  const failClosed = guard.checkLocalGuard({ headers: { host: '127.0.0.1:8392' }, method: 'POST' }, { port: 8392, token: '' });
  report('no token available -> POST refused fail-closed',
    failClosed.ok === false && failClosed.code === 'TOKEN_UNAVAILABLE', JSON.stringify(failClosed.code));
  const failClosedGet = guard.checkLocalGuard({ headers: { host: '127.0.0.1:8392' }, method: 'GET' }, { port: 8392, token: '' });
  report('no token available -> GET still allowed (read-only)', failClosedGet.ok === true);

  // ── 3) 应用内接口（8392 那份实现）在真实 HTTP 上的表现 ───────────────────
  section('in-app api over real http');
  const downloads = [];
  const analyzeCalls = [];
  const apiRoot = tmpDir('qy-root-');
  const downloadRoot = path.join(apiRoot, 'downloads');
  fs.mkdirSync(downloadRoot, { recursive: true });
  const OUTSIDE = path.join(apiRoot, 'elsewhere');
  const API_TOKEN = 'apitoken' + '0'.repeat(24) + 'deadbeef';
  const apiPort = await freePort();
  const api = createAgentApiServer({
    port: apiPort,
    token: API_TOKEN,
    tokenFile: tokenFile,
    version: 'test',
    analyzeMedia: async (payload) => { analyzeCalls.push(payload); return { ok: true, data: { url: payload.url } }; },
    downloadMedia: async (payload) => {
      downloads.push(payload);
      return { ok: true, task_id: 't1', data: { files: [{ path: path.join(payload.outputDir, 'a.mp4'), bytes: 10 }], bytes: 10 } };
    },
    queueSnapshot: () => ({ tasks: [], running: 0, limit: 2 }),
    statusSnapshot: () => ({ listening: true, port: apiPort, url: 'http://127.0.0.1:' + apiPort, error: '' }),
    resolveOutputDir: (candidate) => {
      const roots = core.downloadRoots({ outputDir: downloadRoot, allowedOutputRoots: [] });
      const result = core.resolveContainedOutputDir(candidate, roots);
      return { ...result, roots };
    },
  });
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(apiPort, '127.0.0.1', resolve);
  });

  const downloadHeaders = (extra) => ({ host: '127.0.0.1:' + apiPort, 'content-type': 'application/json', 'x-qingying-token': API_TOKEN, ...extra });
  const legitDownload = JSON.stringify({ url: 'https://example.com/v', outputDir: path.join(downloadRoot, 'sub') });
  const okResp = await request({ method: 'POST', path: '/api/download', port: apiPort, headers: downloadHeaders() }, legitDownload);
  report('legit POST download (token + inside root) -> 200', okResp.status === 200 && okResp.json?.ok === true,
    JSON.stringify(okResp.json));
  report('legit download reached the engine queue with the resolved dir',
    downloads.length === 1 && downloads[0].outputDir === path.join(downloadRoot, 'sub'), downloads[0]?.outputDir);
  report('mutating response carries no Access-Control-Allow-Origin',
    !okResp.headers['access-control-allow-origin'], JSON.stringify(okResp.headers['access-control-allow-origin']));

  const bearerResp = await request({
    method: 'POST', path: '/api/download', port: apiPort,
    headers: { host: '127.0.0.1:' + apiPort, 'content-type': 'application/json', authorization: 'Bearer ' + API_TOKEN },
  }, legitDownload);
  report('Authorization: Bearer is the same door', bearerResp.status === 200 && downloads.length === 2,
    JSON.stringify(bearerResp.json?.ok));

  const noTokenResp = await request({
    method: 'POST', path: '/api/download', port: apiPort,
    headers: { host: '127.0.0.1:' + apiPort, 'content-type': 'application/json' },
  }, legitDownload);
  report('POST without token -> 401 JSON body',
    noTokenResp.status === 401 && noTokenResp.json?.error?.code === 'TOKEN_REQUIRED' && noTokenResp.json.ok === false,
    JSON.stringify(noTokenResp.json?.error?.code));
  report('refused POST never reached the queue', downloads.length === 2);

  const evilOriginResp = await request({
    method: 'POST', path: '/api/download', port: apiPort,
    headers: downloadHeaders({ origin: 'https://evil.example.com' }),
  }, legitDownload);
  report('cross-origin browser POST -> 403 even with a token',
    evilOriginResp.status === 403 && evilOriginResp.json?.error?.code === 'ORIGIN_NOT_ALLOWED',
    JSON.stringify(evilOriginResp.json?.error?.code));
  report('cross-origin POST never reached the download queue', downloads.length === 2);

  const rebindingResp = await request({
    method: 'POST', path: '/api/download', port: apiPort,
    headers: downloadHeaders({ host: 'rebind.attacker.test:' + apiPort, origin: 'http://rebind.attacker.test:' + apiPort }),
  }, legitDownload);
  report('DNS-rebinding shape (Host==Origin) -> 403 HOST_NOT_ALLOWED',
    rebindingResp.status === 403 && rebindingResp.json?.error?.code === 'HOST_NOT_ALLOWED',
    JSON.stringify(rebindingResp.json?.error?.code));

  const wrongPortHost = await request({ method: 'GET', path: '/health', port: apiPort, headers: { host: '127.0.0.1:' + (apiPort + 1) } });
  report('Host port must equal the listening port',
    wrongPortHost.status === 403 && wrongPortHost.json?.error?.code === 'HOST_NOT_ALLOWED',
    JSON.stringify(wrongPortHost.json?.error?.code));

  const outsideResp = await request({
    method: 'POST', path: '/api/download', port: apiPort, headers: downloadHeaders(),
  }, JSON.stringify({ url: 'https://example.com/v', outputDir: OUTSIDE }));
  report('outputDir outside the download root -> 403 + actionable message',
    outsideResp.status === 403 && outsideResp.json?.code === 'output_dir_outside_root'
    && /下载根目录/.test(outsideResp.json?.error || '') && Array.isArray(outsideResp.json?.download_roots),
    JSON.stringify(outsideResp.json));
  report('refused outputDir never reached the queue and made no dir',
    downloads.length === 2 && !fs.existsSync(OUTSIDE));

  const traversalResp = await request({
    method: 'POST', path: '/api/download', port: apiPort, headers: downloadHeaders(),
  }, JSON.stringify({ url: 'https://example.com/v', outputDir: path.join(downloadRoot, '..', 'elsewhere2') }));
  report('.. traversal out of the root -> refused',
    traversalResp.status === 403 && traversalResp.json?.code === 'output_dir_outside_root',
    JSON.stringify(traversalResp.json?.code));
  report('traversal target not created', !fs.existsSync(path.join(apiRoot, 'elsewhere2')));

  // junction 越界：根目录里放一个指向外面的链接点，realpath 之后必须被拒。
  const elsewhere = path.join(apiRoot, 'elsewhere-junction');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'do-not-touch');
  const junction = path.join(downloadRoot, 'alias');
  let junctionMade = false;
  try {
    fs.symlinkSync(elsewhere, junction, 'junction');
    junctionMade = true;
  } catch (error) {
    console.log('SKIP  junction escape (platform cannot create junctions: ' + ascii(error.code) + ')');
  }
  if (junctionMade) {
    const junctionResp = await request({
      method: 'POST', path: '/api/download', port: apiPort, headers: downloadHeaders(),
    }, JSON.stringify({ url: 'https://example.com/v', outputDir: junction }));
    report('outputDir that is a junction out of the root -> refused',
      junctionResp.status === 403 && junctionResp.json?.code === 'output_dir_outside_root',
      JSON.stringify({ status: junctionResp.status, code: junctionResp.json?.code }));
    report('nothing written through the junction', downloads.length === 2
      && fs.existsSync(path.join(elsewhere, 'keep.txt')) && !fs.existsSync(path.join(elsewhere, 'a.mp4')));
  }

  const healthResp = await request({ method: 'GET', path: '/health', port: apiPort, headers: { host: '127.0.0.1:' + apiPort } });
  report('GET /health without token works and reports its own guard',
    healthResp.status === 200 && healthResp.json?.guard?.token_required === true
    && /127\.0\.0\.1:/.test(healthResp.json?.guard?.host_allowlist || '')
    && healthResp.json?.guard?.cookie_values_never_returned === true,
    JSON.stringify(healthResp.json?.guard));
  report('health never echoes the token value', !JSON.stringify(healthResp.json).includes(API_TOKEN));

  const statusResp = await request({ method: 'GET', path: '/api/status', port: apiPort, headers: { host: '127.0.0.1:' + apiPort } });
  report('GET /api/status reports the real bind state',
    statusResp.status === 200 && statusResp.json?.data?.listening === true && statusResp.json.data.port === apiPort,
    JSON.stringify(statusResp.json?.data));

  const analyzeResp = await request({
    method: 'POST', path: '/api/analyze', port: apiPort, headers: downloadHeaders(),
  }, JSON.stringify({ url: 'https://example.com/v' }));
  report('POST /api/analyze needs the token too and works with it',
    analyzeResp.status === 200 && analyzeCalls.length === 1, JSON.stringify(analyzeResp.json?.ok));

  const optionsResp = await request({
    method: 'OPTIONS', path: '/api/download', port: apiPort,
    headers: { host: '127.0.0.1:' + apiPort, origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
  });
  report('no preflight is granted for mutating routes',
    !optionsResp.headers['access-control-allow-origin'] && optionsResp.headers['access-control-allow-methods'] === undefined,
    JSON.stringify(optionsResp.headers['access-control-allow-origin']));

  api.close();

  // ── 4) 独立 Agent API(8793 那份实现) + MCP 桥：只靠 0600 令牌文件也能干活 ──
  section('standalone agent api + mcp bridge with the token file only');
  const agentData = tmpDir('qy-agent-data-');
  const agentDownloads = path.join(agentData, 'downloads');
  const agentPort = await freePort();
  const agentEnv = { ...process.env, AGENT_PORT: String(agentPort), QINGYING_DATA_DIR: agentData, AGENT_ENDPOINT_FILE: path.join(agentData, '.endpoint') };
  delete agentEnv.QINGYING_API_TOKEN;
  const agentProc = spawn(process.execPath, [path.join(ROOT, 'agent', 'server.mjs')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: agentEnv,
  });
  let agentLog = '';
  agentProc.stdout.on('data', (c) => { agentLog += c.toString('utf8'); });
  agentProc.stderr.on('data', (c) => { agentLog += c.toString('utf8'); });

  async function waitForHealth(port, limit = 60) {
    for (let i = 0; i < limit; i += 1) {
      try {
        const res = await request({ method: 'GET', path: '/api/health', port, headers: { host: '127.0.0.1:' + port } });
        if (res.status === 200) return res;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }

  try {
    const agentHealth = await waitForHealth(agentPort);
    report('agent api starts with a file-backed token (no env token given)',
      agentHealth && agentHealth.json?.data?.guard?.token_available === true
      && agentHealth.json.data.guard.token_source === 'created',
      JSON.stringify(agentHealth?.json?.data?.guard || {}) + ' / log=' + agentLog.slice(0, 160));
    const createdTokenFile = path.join(agentData, 'agent-api.token');
    report('agent api created the shared token file in its app-data', fs.existsSync(createdTokenFile), createdTokenFile);
    if (process.platform !== 'win32') {
      report('agent token file is 0600 on disk', (fs.statSync(createdTokenFile).mode & 0o777) === 0o600,
        (fs.statSync(createdTokenFile).mode & 0o777).toString(8));
    }
    report('agent api health leaks no token value',
      !JSON.stringify(agentHealth?.json || {}).includes(fs.existsSync(createdTokenFile) ? fs.readFileSync(createdTokenFile, 'utf8').trim() : '__none__'));
    const optionsToAgent = await request({
      method: 'OPTIONS', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, origin: 'https://evil.example.com' },
    });
    report('agent api grants no cross-origin header on OPTIONS',
      optionsToAgent.headers['access-control-allow-origin'] === undefined
      && optionsToAgent.status === 403, JSON.stringify({ status: optionsToAgent.status }));

    const unauthCall = await request({
      method: 'POST', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, 'content-type': 'application/json' },
    }, JSON.stringify({ tool: 'qingying.settings_set', input: { output_dir: agentDownloads } }));
    report('unauthenticated write to agent api -> 401',
      unauthCall.status === 401 && unauthCall.json?.error?.code === 'TOKEN_REQUIRED',
      JSON.stringify(unauthCall.json?.error?.code));
    report('unauthenticated write changed no settings file', !fs.existsSync(path.join(agentData, 'settings.json')));

    const mcp = await mcpCall(agentPort, agentData);
    report('MCP bridge authenticates from the 0600 token file (no env token)',
      mcp.callResult && mcp.callResult.isError === false && !/调用失败/.test(mcp.callText),
      (mcp.timedOut ? 'TIMEOUT ' : '') + (mcp.callText || mcp.raw || mcp.err).slice(0, 140));

    const tokenValue = fs.readFileSync(createdTokenFile, 'utf8').trim();
    const rootPatch = await request({
      method: 'POST', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, 'content-type': 'application/json', 'x-qingying-token': tokenValue },
    }, JSON.stringify({ tool: 'qingying.settings_set', input: { output_dir: agentDownloads } }));
    report('tokened settings_set can designate the download root',
      rootPatch.status === 200 && rootPatch.json?.data?.settings?.outputDir === agentDownloads,
      JSON.stringify(rootPatch.json?.error || rootPatch.json?.data?.download_roots));

    const outsideAfterRoot = await request({
      method: 'POST', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, 'content-type': 'application/json', 'x-qingying-token': tokenValue },
    }, JSON.stringify({ tool: 'qingying.download', input: { url: 'https://example.com/v', confirm: true, output_dir: OUTSIDE } }));
    report('agent tool refuses output_dir outside the root (400, nothing written)',
      outsideAfterRoot.status === 400 && outsideAfterRoot.json?.error?.code === 'output_dir_outside_root'
      && !fs.existsSync(OUTSIDE), JSON.stringify(outsideAfterRoot.json?.error?.code));

    const relativeDir = await request({
      method: 'POST', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, 'content-type': 'application/json', 'x-qingying-token': tokenValue },
    }, JSON.stringify({ tool: 'qingying.download', input: { url: 'https://example.com/v', confirm: true, output_dir: 'relative/sub' } }));
    report('agent tool refuses a relative output_dir',
      relativeDir.json?.error?.code === 'output_dir_not_absolute', JSON.stringify(relativeDir.json?.error?.code));

    const insideDir = path.join(agentDownloads, 'ok-sub');
    const insideCall = await request({
      method: 'POST', path: '/api/agent/tool', port: agentPort,
      headers: { host: '127.0.0.1:' + agentPort, 'content-type': 'application/json', 'x-qingying-token': tokenValue },
    }, JSON.stringify({ tool: 'qingying.download', input: { url: 'https://example.com/v', confirm: true, output_dir: insideDir } }));
    const insideCode = insideCall.json?.error?.code || '';
    report('legit agent download path still passes the directory gate',
      insideCall.json?.ok === true || !/^output_dir|^no_download_root/.test(insideCode),
      JSON.stringify({ status: insideCall.status, code: insideCode }));
    report('legit output_dir got created under the root',
      fs.existsSync(insideDir) && fs.statSync(insideDir).isDirectory(), insideDir);
  } finally {
    agentProc.kill();
    for (const dir of [tokenDir, apiRoot, agentData]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  console.log(`\n${checks - failures}/${checks} guard checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.log('SCRIPT FAIL: ' + ascii(error && error.stack ? error.stack.split('\n').slice(0, 3).join(' ') : error));
  process.exit(1);
});
