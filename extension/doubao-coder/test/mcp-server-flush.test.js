/**
 * MCP server 退出冲刷测试：stdin 关闭前的最后一次响应必须完整写出。
 * 用法：node test/mcp-server-flush.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-mcp-flush-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'flush-ok');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail ? ' → ' + detail : ''));
  }
}

const child = spawn(process.execPath, [path.join(__dirname, '..', 'out', 'mcp', 'server.js')], {
  env: { ...process.env, DOUBAO_MCP_ROOT: root },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'a.txt' } } }) + '\n');
child.stdin.end();

const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 8000);
child.on('close', (code) => {
  clearTimeout(killer);
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  const init = lines.find((m) => m.id === 1);
  const call = lines.find((m) => m.id === 2);
  check('initialize 有响应', Boolean(init && init.result), JSON.stringify(init));
  check('最后一次 tools/call 有响应', Boolean(call && call.result), 'stdout=' + JSON.stringify(stdout.slice(-300)));
  check('read_file 内容正确', Boolean(call && call.result && JSON.stringify(call.result).includes('flush-ok')), JSON.stringify(call));
  check('进程正常退出', code === 0, 'code=' + code + ' stderr=' + stderr.slice(-200));
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
});
