/**
 * 豆包 CLI 自动安装器离线单测：npm 参数 / npm-cli 定位 / 安装进程生命周期。
 * 用法：node test/cli-install.test.js
 */
const { EventEmitter } = require('node:events');
const path = require('node:path');

const {
  CLI_INSTALL_ARGS,
  CLI_PACKAGE,
  CLI_REGISTRY,
  nodeCandidates,
  npmCliCandidates,
  resolveNodeExec,
  resolveNpmCli,
  runNpmInstall,
  parseNodeVersion,
  isUselessNodePath,
} = require(path.join(__dirname, '..', 'out', 'cli', 'install.js'));

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

/* ---- 安装参数 ---- */
check('参数：全局安装官方包', CLI_INSTALL_ARGS.includes('-g') && CLI_INSTALL_ARGS.includes(CLI_PACKAGE), CLI_INSTALL_ARGS.join(' '));
check('参数：固定 npm 官方源', CLI_INSTALL_ARGS.includes('--registry=' + CLI_REGISTRY));
check('参数：不审计、不提示 fund', CLI_INSTALL_ARGS.includes('--no-audit') && CLI_INSTALL_ARGS.includes('--no-fund'));

/* ---- npm-cli 定位 ---- */
const execPath = 'C:\\Program Files\\nodejs\\node.exe';
const candidates = npmCliCandidates(execPath, {
  npm_execpath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
  PATH: 'C:\\tools',
});
check('定位：优先 npm_execpath', candidates[0].toLowerCase() === path.normalize('C:\\npm\\node_modules\\npm\\bin\\npm-cli.js').toLowerCase(), candidates.join(' | '));
check('定位：包含 Node 安装目录', candidates.some((item) => item.toLowerCase().includes('node_modules\\npm\\bin\\npm-cli.js')), candidates.join(' | '));
check('定位：包含 PATH 候选', candidates.some((item) => item.toLowerCase() === path.normalize('C:\\tools\\node_modules\\npm\\bin\\npm-cli.js').toLowerCase()), candidates.join(' | '));

const nodeExec = resolveNodeExec();
check('定位：本机可解析到 node 可执行文件', Boolean(nodeExec) && /node(\.exe)?$/i.test(nodeExec), String(nodeExec));
const resolved = resolveNpmCli(nodeExec || process.execPath);
check('定位：本机可解析到 npm-cli.js', Boolean(resolved) && resolved.toLowerCase().endsWith('npm-cli.js'), String(resolved));
check(
  '定位：nodeCandidates 包含 PATH 里的 node',
  nodeCandidates('C:\\Program Files\\nodejs\\node.exe', { PATH: 'C:\\tools' }).some((item) => item.toLowerCase() === path.normalize('C:\\tools\\node.exe').toLowerCase()),
);

/* ---- 安装进程 ---- */
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
    const lines = [];
    const { impl, calls } = fakeSpawn((child) => {
      child.stdout.emit('data', 'added 1 package\n');
      child.stderr.emit('data', 'npm warn deprecated foo\n');
      setImmediate(() => child.emit('close', 0, null));
    });
    const result = await runNpmInstall({
      nodeExec: process.execPath,
      npmCli: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
      spawnImpl: impl,
      onLine: (line) => lines.push(line),
    });
    check('安装成功：ok=true', result.ok === true, JSON.stringify(result));
    check('安装成功：命令行用当前 Node 执行 npm-cli.js', calls[0].file === process.execPath && calls[0].args[0].endsWith('npm-cli.js'), JSON.stringify(calls[0]));
    check('安装成功：输出按行回调', lines.some((line) => line.includes('added 1 package')), lines.join(' | '));
    check('安装成功：保留完整输出', result.output.includes('added 1 package'));
  }

  {
    const { impl } = fakeSpawn((child) => {
      child.stderr.emit('data', 'npm error code EACCES\n');
      setImmediate(() => child.emit('close', 1, null));
    });
    const result = await runNpmInstall({ nodeExec: process.execPath,
      npmCli: 'npm-cli.js', spawnImpl: impl });
    check('安装失败：ok=false 且保留退出码', result.ok === false && result.code === 1);
    check('安装失败：输出包含错误', result.output.includes('EACCES'));
  }

  {
    const controller = new AbortController();
    const { impl } = fakeSpawn(() => {
      controller.abort();
    });
    const result = await runNpmInstall({ nodeExec: process.execPath,
      npmCli: 'npm-cli.js', spawnImpl: impl, signal: controller.signal });
    check('取消：aborted=true', result.aborted === true && result.ok === false);
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
    const result = await runNpmInstall({ nodeExec: process.execPath,
      npmCli: 'npm-cli.js', spawnImpl: impl, timeoutMs: 20 });
    check('超时：timedOut=true 且杀进程', result.timedOut === true && killed === true);
  }

  /* ---- Node 版本解析 / 候选过滤 ---- */
check('Node 版本：正常输出', parseNodeVersion('v20.11.0\n').version === 'v20.11.0' && parseNodeVersion('v20.11.0').major === 20);
check('Node 版本：空输出不当作 0.x', parseNodeVersion('').version === undefined);
check('Node 版本：垃圾输出不误判', parseNodeVersion('not a version').version === undefined);
check('Node 路径：跳过 WindowsApps 别名', isUselessNodePath('C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps\\node.exe') === true);
check('Node 路径：正常安装目录可用', isUselessNodePath('C:\\Program Files\\nodejs\\node.exe') === false);
const filtered = nodeCandidates(process.execPath, { PATH: 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Program Files\\nodejs' });
check('Node 候选：过滤 WindowsApps', filtered.every((item) => !/WindowsApps/i.test(item)));
check('Node 候选：保留正常路径', filtered.some((item) => /Program Files/i.test(item)));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    process.exitCode = 1;
  }
})();
