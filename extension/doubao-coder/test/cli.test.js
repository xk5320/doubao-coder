/**
 * 豆包 CLI 轻量通道离线单测：参数拼装 / 输出清理 / 会话捕获 / 进程生命周期。
 * 用法：node test/cli.test.js
 */
const { EventEmitter } = require('node:events');
const path = require('node:path');

const fs = require('node:fs');
const pkg = require(path.join(__dirname, '..', 'package.json'));
const { candidateBinaries } = require(path.join(__dirname, '..', 'out', 'cli', 'detect.js'));
const {
  buildCliArgs,
  collapseCarriageReturns,
  extractSessionId,
  isResumeRejected,
  normalizeCliText,
  runCliTask,
  statusLine,
  stripAnsi,
} = require(path.join(__dirname, '..', 'out', 'cli', 'runner.js'));

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

/* ---- 输出清理 ---- */
check('stripAnsi 去掉颜色', stripAnsi('\u001b[31m错误\u001b[0m') === '错误');
check('stripAnsi 去掉光标控制', stripAnsi('a\u001b[2Kb') === 'ab');
check('collapseCarriageReturns 保留最后一段', collapseCarriageReturns('进度 10%\r进度 50%\r完成') === '完成');
check('normalizeCliText 压缩空行并 trim', normalizeCliText('\n\n 第一行  \n\n\n\n第二行 \n') === '第一行\n\n第二行');
check('statusLine 单行化', statusLine('正在读取\nREADME.md  ', 40) === '正在读取 README.md');

/* ---- 参数拼装 ---- */
const args = buildCliArgs({
  prompt: '总结当前目录',
  cwd: 'D:\\work\\demo',
  resumeId: 'sess-123456',
  model: 'doubao-seed-code',
  effort: 'High',
  permissionMode: 'ask_risky',
});
check('参数顺序：-C 在最前', args[0] === '-C' && args[1] === 'D:\\work\\demo', JSON.stringify(args));
check('--resume 传入会话 ID', args.includes('--resume') && args.includes('sess-123456'));
check('--model / --effort / --permission-mode', args.includes('--model') && args.includes('High') && args.includes('ask_risky'));
check('-p 在最后且提示词是一个参数', args[args.length - 2] === '-p' && args[args.length - 1] === '总结当前目录');
const minimal = buildCliArgs({ prompt: 'hi' });
check('最小参数只有 -p', minimal.length === 2 && minimal[0] === '-p' && minimal[1] === 'hi');
const quoted = buildCliArgs({ prompt: '带 "引号" 与 $符号 的提示词' });
check('提示词不拆参数（不经过 shell）', quoted.length === 2 && quoted[1] === '带 "引号" 与 $符号 的提示词');

/* ---- 会话 ID / resume 失效 ---- */
check('extractSessionId 识别 session id', extractSessionId('ok\nsession id: 8f3a2b1c-77aa') === '8f3a2b1c-77aa');
check('extractSessionId 识别 --resume 提示', extractSessionId('To continue: doubao --resume abc123456') === 'abc123456');
check('extractSessionId 无匹配返回 undefined', extractSessionId('普通输出，没有会话信息') === undefined);
check('isResumeRejected 识别失效', isResumeRejected('Error: session 8f3 not found'));
check('isResumeRejected 识别中文失效', isResumeRejected('会话已失效，请新建会话'));
check('isResumeRejected 普通错误不误判', !isResumeRejected('network timeout'));

/* ---- 探测顺序 ---- */
const candidates = candidateBinaries('C:\\custom\\doubao.exe', {
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  PATH: 'C:\\tools',
}, 'win32');
check('探测：配置路径优先', candidates[0].toLowerCase() === 'c:\\custom\\doubao.exe', candidates.join(' | '));
check('探测：包含应用数据目录', candidates.some((item) => item.toLowerCase().includes('doubao_cli')), candidates.join(' | '));
check('探测：包含 PATH 里的 doubao.exe', candidates.some((item) => item.toLowerCase() === 'c:\\tools\\doubao.exe'), candidates.join(' | '));

/* ---- 清单与接线 ---- */
const cliCommands = [
  'doubao.selectConnectionMode',
  'doubao.cliLogin',
  'doubao.cliCheck',
  'doubao.cliInstall',
  'doubao.cliOpenTerminal',
  'doubao.cliStartService',
];
check('清单：authMode 支持 cli', pkg.contributes.configuration.properties['doubao.authMode'].enum.includes('cli'));
check('清单：六个 CLI 命令都已声明', cliCommands.every((name) => pkg.contributes.commands.some((item) => item.command === name)), cliCommands.join(','));
const extensionJs = fs.readFileSync(path.join(__dirname, '..', 'out', 'extension.js'), 'utf8');
check('编译产物：注册连接方式命令', extensionJs.includes('doubao.selectConnectionMode'));
check('编译产物：包含 CLI 登录命令', extensionJs.includes('doubao.cliLogin'));
const panelJs = fs.readFileSync(path.join(__dirname, '..', 'out', 'chat', 'panel.js'), 'utf8');
check('编译产物：面板调用 CLI 任务', panelJs.includes('runCliTask') && panelJs.includes('cliPermissionMode'));

/* ---- 进程生命周期 ---- */
function fakeSpawn(script) {
  const calls = [];
  const impl = (file, args) => {
    calls.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => undefined;
    child.stderr.setEncoding = () => undefined;
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    setImmediate(() => script(child));
    return child;
  };
  return { impl, calls };
}

(async () => {
  {
    const { impl, calls } = fakeSpawn((child) => {
      child.stdout.emit('data', '\u001b[32m正在执行\u001b[0m\n');
      child.stdout.emit('data', 'session id: abcdef12\n最终回答');
      setImmediate(() => child.emit('close', 0, null));
    });
    const result = await runCliTask({ binary: 'doubao.exe', prompt: 'hi', spawnImpl: impl, timeoutMs: 5000 });
    check('成功：ok=true', result.ok === true, JSON.stringify(result));
    check('成功：输出被清理', result.text === '正在执行\nsession id: abcdef12\n最终回答' || result.text === '正在执行\nsession id: abcdef12\n最终回答', result.text);
    check('成功：捕获会话 ID', result.sessionId === 'abcdef12', String(result.sessionId));
    check('成功：参数带 -p', calls[0].args.includes('-p') && calls[0].args.includes('hi'));
  }

  {
    const { impl } = fakeSpawn((child) => {
      child.stderr.emit('data', '\u001b[31m未登录\u001b[0m');
      setImmediate(() => child.emit('close', 2, null));
    });
    const result = await runCliTask({ binary: 'doubao.exe', prompt: 'hi', spawnImpl: impl });
    check('失败：ok=false 且保留退出码', result.ok === false && result.code === 2);
    check('失败：stderr 可读', normalizeCliText(result.stderr) === '未登录');
  }

  {
    const controller = new AbortController();
    const { impl } = fakeSpawn((child) => {
      controller.abort();
    });
    const result = await runCliTask({ binary: 'doubao.exe', prompt: 'hi', spawnImpl: impl, signal: controller.signal });
    check('中断：aborted=true', result.aborted === true && result.ok === false);
  }

  {
    let killed = false;
    const { impl } = fakeSpawn((child) => {
      child.kill = () => {
        killed = true;
        setImmediate(() => child.emit('close', null, 'SIGKILL'));
        return true;
      };
    });
    const result = await runCliTask({ binary: 'doubao.exe', prompt: 'hi', spawnImpl: impl, timeoutMs: 20, killGraceMs: 20 });
    check('超时：timedOut=true 且杀掉进程', result.timedOut === true && killed === true);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    process.exitCode = 1;
  }
})();
