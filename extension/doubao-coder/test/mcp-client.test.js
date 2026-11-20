/**
 * MCP stdio 客户端离线测试（不依赖 jest）。
 * 用法：node test/mcp-client.test.js（需先执行 tsc）
 */
const path = require('node:path');

const clientModule = require(path.join(__dirname, '..', 'out', 'mcp', 'client.js'));
const { McpClient, McpClientPool, McpError, McpToolError, qualifiedToolName } = clientModule;

const MOCK = path.join(__dirname, 'fixtures', 'mock-mcp-server.js');
const NODE = process.execPath;

let pass = 0;
let fail = 0;
let unhandled = 0;

process.on('unhandledRejection', (reason) => {
  unhandled += 1;
  console.error('  UNHANDLED REJECTION:', reason);
});

function check(name, condition, detail) {
  if (condition) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail === undefined ? '' : ' → ' + detail));
  }
}

async function expectReject(name, action, predicate) {
  try {
    await action();
    check(name, false, '没有抛错');
  } catch (err) {
    let ok = false;
    try {
      ok = predicate(err) === true;
    } catch (predicateError) {
      ok = false;
    }
    check(name, ok, err instanceof Error ? err.message : String(err));
  }
}

const tracked = [];
function track(client) {
  tracked.push(client);
  return client;
}

async function main() {
  /* ------------------------------------------------------------------ */
  /* 1. 握手 + stderr 日志                                                */
  /* ------------------------------------------------------------------ */
  const logs = [];
  const client = track(
    new McpClient(
      {
        name: 'mock',
        command: NODE,
        args: [MOCK],
        timeoutMs: 5000,
        env: { MOCK_SECRET_TOKEN: 'sekret-abc-123' },
      },
      { onLog: (event) => logs.push(event) },
    ),
  );
  await client.start();
  check('握手：start() 成功且 connected', client.connected === true);
  check('握手：protocolVersion = 2024-11-05', client.protocolVersion === '2024-11-05', client.protocolVersion);
  check(
    '握手：serverInfo 可读',
    client.serverInfo !== undefined && client.serverInfo.name === 'mock-mcp-server',
    JSON.stringify(client.serverInfo),
  );
  check('日志：stderr 通过 onLog 转出', logs.some((event) => event.server === 'mock'));
  check(
    '日志：不泄露 env 密钥',
    logs.every((event) => !event.message.includes('sekret-abc-123')),
  );

  /* ------------------------------------------------------------------ */
  /* 2. tools/list（cursor 分页）                                         */
  /* ------------------------------------------------------------------ */
  const tools = await client.listTools();
  check('tools/list：分页合并出 3 个工具', tools.length === 3, String(tools.length));
  const echoInfo = tools.find((tool) => tool.name === 'echo');
  check(
    'tools/list：echo 元数据正确',
    echoInfo !== undefined &&
      echoInfo.server === 'mock' &&
      echoInfo.qualifiedName === 'mcp__mock__echo' &&
      echoInfo.inputSchema.type === 'object',
    JSON.stringify(echoInfo),
  );
  check('tools/list：fail 来自第二页', tools.some((tool) => tool.name === 'fail'));

  /* ------------------------------------------------------------------ */
  /* 3. tools/call 成功                                                   */
  /* ------------------------------------------------------------------ */
  const echoed = await client.callTool('echo', { message: '你好 MCP', count: 2 });
  check('tools/call echo：isError=false', echoed.isError === false);
  check('tools/call echo：content 为 text', echoed.content[0] && echoed.content[0].type === 'text');
  const parsedEcho = JSON.parse(echoed.text);
  check(
    'tools/call echo：原样返回参数',
    parsedEcho.message === '你好 MCP' && parsedEcho.count === 2,
    echoed.text,
  );

  /* ------------------------------------------------------------------ */
  /* 4. tools/call 工具报错                                               */
  /* ------------------------------------------------------------------ */
  const failed = await client.callTool('fail', { reason: 'demo' });
  check('tools/call fail：isError=true', failed.isError === true);
  check('tools/call fail：错误文本可读', failed.text.includes('失败'), failed.text);

  /* ------------------------------------------------------------------ */
  /* 5. 非法 JSON 行不炸客户端                                            */
  /* ------------------------------------------------------------------ */
  const garbageLogs = [];
  const noisy = track(
    new McpClient(
      { name: 'noisy', command: NODE, args: [MOCK, '--garbage'], timeoutMs: 5000 },
      { onLog: (event) => garbageLogs.push(event) },
    ),
  );
  await noisy.start();
  check('非法 JSON 行：握手仍然成功', noisy.connected === true);
  const noisyEcho = await noisy.callTool('echo', { ok: true });
  check('非法 JSON 行：后续调用正常', JSON.parse(noisyEcho.text).ok === true);
  check(
    '非法 JSON 行：记录了可读告警',
    garbageLogs.some((event) => event.message.includes('无法解析')),
  );
  await noisy.close();

  /* ------------------------------------------------------------------ */
  /* 6. 半行 / 粘包                                                       */
  /* ------------------------------------------------------------------ */
  for (const mode of ['--fragment', '--sticky']) {
    const framed = track(
      new McpClient({ name: 'framed' + mode, command: NODE, args: [MOCK, mode], timeoutMs: 5000 }),
    );
    await framed.start();
    const framedEcho = await framed.callTool('echo', { mode: mode });
    check('半行/粘包（' + mode + '）：调用正常', JSON.parse(framedEcho.text).mode === mode);
    await framed.close();
  }

  /* ------------------------------------------------------------------ */
  /* 7. server 崩溃后 pending 被拒绝                                      */
  /* ------------------------------------------------------------------ */
  const crashing = track(new McpClient({ name: 'crashy', command: NODE, args: [MOCK], timeoutMs: 5000 }));
  await crashing.start();
  let crashError;
  try {
    await crashing.callTool('crash', {});
    check('崩溃：pending 被拒绝', false, '没有抛错');
  } catch (err) {
    crashError = err;
    check('崩溃：pending 被拒绝', true);
  }
  check(
    '崩溃：错误信息可读',
    crashError instanceof McpError && crashError.message.includes('退出'),
    crashError instanceof Error ? crashError.message : String(crashError),
  );
  check('崩溃：status() 显示不可用', crashing.status().ok === false);
  await crashing.close();
  await crashing.close();
  check('崩溃：close() 幂等', true);

  /* ------------------------------------------------------------------ */
  /* 8. 启动失败（命令不存在）                                            */
  /* ------------------------------------------------------------------ */
  const missing = track(
    new McpClient({ name: 'missing', command: 'definitely-not-a-real-command-xyz', timeoutMs: 2000 }),
  );
  await expectReject(
    '启动失败：命令不存在时错误可读',
    () => missing.start(),
    (err) =>
      err instanceof McpError && (err.message.includes('启动失败') || err.message.includes('ENOENT')),
  );
  check('启动失败：status() 不可用', missing.status().ok === false);
  await missing.close();

  /* ------------------------------------------------------------------ */
  /* 9. 连接池                                                            */
  /* ------------------------------------------------------------------ */
  const poolLogs = [];
  const pool = new McpClientPool({ onLog: (event) => poolLogs.push(event) });
  let poolDisposed = false;
  try {
    const statuses = await pool.start([
      { name: 'good', command: NODE, args: [MOCK] },
      { name: 'bad', command: NODE, args: [MOCK, '--exit-on-start'] },
      { name: '中文 服务', command: NODE, args: [MOCK] },
      { name: 'off', command: NODE, args: [MOCK], enabled: false },
    ]);
    const byName = new Map(statuses.map((status) => [status.name, status]));
    check('pool：返回 4 个 server 状态', statuses.length === 4, String(statuses.length));
    check(
      'pool：good 启动成功且工具数为 3',
      byName.get('good') !== undefined && byName.get('good').ok === true && byName.get('good').toolCount === 3,
      JSON.stringify(byName.get('good')),
    );
    check(
      'pool：bad 启动失败但 error 可读',
      byName.get('bad') !== undefined &&
        byName.get('bad').ok === false &&
        typeof byName.get('bad').error === 'string' &&
        byName.get('bad').error.length > 0,
      JSON.stringify(byName.get('bad')),
    );
    check('pool：一个失败不影响另一个', Boolean(byName.get('good')) && byName.get('good').ok === true);
    check(
      'pool：disabled 不启动',
      byName.get('off') !== undefined && byName.get('off').ok === false && byName.get('off').error.includes('禁用'),
      JSON.stringify(byName.get('off')),
    );

    const poolTools = await pool.listTools();
    check('pool：工具汇总包含 mcp__good__echo', poolTools.some((tool) => tool.qualifiedName === 'mcp__good__echo'));
    const chineseTool = poolTools.find((tool) => tool.server === '中文 服务' && tool.name === 'echo');
    check(
      'pool：中文 server 名被安全限定',
      chineseTool !== undefined && /^mcp__[A-Za-z0-9_]+__echo$/.test(chineseTool.qualifiedName),
      chineseTool && chineseTool.qualifiedName,
    );
    check(
      'pool：qualifiedName 路由正确',
      JSON.parse(await pool.callTool('mcp__good__echo', { via: 'pool' })).via === 'pool',
    );
    check(
      'pool：中文限定名也能路由',
      chineseTool !== undefined && JSON.parse(await pool.callTool(chineseTool.qualifiedName, { cn: true })).cn === true,
    );
    await expectReject(
      'pool：未知工具报错可读',
      () => pool.callTool('mcp__nope__x', {}),
      (err) => err instanceof McpError && err.message.includes('未找到'),
    );
    await expectReject(
      'pool：工具 isError 转为异常',
      () => pool.callTool('mcp__good__fail', {}),
      (err) => err instanceof McpToolError && err.text.includes('失败'),
    );
    check(
      'pool：qualifiedToolName 不残留中文',
      /^mcp__[A-Za-z0-9_]+$/.test(qualifiedToolName('中文 服务', '工具 一')),
      qualifiedToolName('中文 服务', '工具 一'),
    );

    await pool.dispose();
    await pool.dispose();
    poolDisposed = true;
    check('pool：dispose 幂等', true);
    check(
      'pool：dispose 后状态为已关闭',
      pool.status().every((status) => status.ok === false),
    );
    await expectReject(
      'pool：dispose 后调用报错',
      () => pool.callTool('mcp__good__echo', {}),
      (err) => err instanceof McpError && err.message.includes('已关闭'),
    );
  } finally {
    if (!poolDisposed) {
      await pool.dispose().catch(() => undefined);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 10. 无 unhandled rejection                                           */
  /* ------------------------------------------------------------------ */
  await new Promise((resolve) => setTimeout(resolve, 50));
  check('无 unhandled rejection', unhandled === 0, 'unhandled=' + String(unhandled));
}

(async () => {
  try {
    await main();
  } catch (err) {
    fail += 1;
    console.error('测试执行异常：', err);
  } finally {
    for (const client of tracked) {
      try {
        await client.close();
      } catch (err) {
        console.error('清理客户端失败：', err && err.message ? err.message : err);
      }
    }
  }
  console.log('');
  console.log('结果：PASS ' + pass + '，FAIL ' + fail);
  if (fail > 0) {
    process.exitCode = 1;
  }
})();
