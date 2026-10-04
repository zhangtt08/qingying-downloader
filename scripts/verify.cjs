'use strict';
// npm run verify —— 把"必须能红"的行为测试串成一道闸门。
// 与 npm run check（静态/单元判据）分工：这里跑的每一条都会起真实进程或真实写盘，
// 每条断言都做过变异检查（把修复撤掉它必须变红），所以它不是装饰。
// 不出网、不碰用户真实 app-data（一律临时目录 + 随机回环端口）。
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SUITES = [
  ['api guard', 'scripts/api-guard.test.cjs'],
];

let failed = 0;
for (const [label, file] of SUITES) {
  const target = path.join(ROOT, file);
  if (!fs.existsSync(target)) {
    console.log(`FAIL  ${label} :: missing ${file}`);
    failed += 1;
    continue;
  }
  const started = Date.now();
  const result = spawnSync(process.execPath, [target], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  const output = String(result.stdout || '') + String(result.stderr || '');
  const lines = output.split(/\r?\n/).filter(Boolean);
  const failing = lines.filter((line) => line.startsWith('FAIL') || line.startsWith('SCRIPT FAIL'));
  // 只回显失败行 + 最后一行的计数，通过的那一大段留给各自脚本的日志。
  const tail = lines[lines.length - 1] || '(no output)';
  const ok = result.status === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  verify: ${label} (${file}) in ${((Date.now() - started) / 1000).toFixed(1)}s :: ${tail}`);
  for (const line of failing.slice(0, 40)) console.log('      ' + line.replace(/[^ -~]/g, '?'));
  if (!ok && result.error) console.log('      ' + String(result.error.message).replace(/[^ -~]/g, '?'));
}
console.log(failed ? `\nverify FAILED (${failed} suite${failed > 1 ? 's' : ''})` : '\nverify OK');
process.exit(failed ? 1 : 0);
