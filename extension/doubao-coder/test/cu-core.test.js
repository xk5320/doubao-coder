/**
 * CU 移植核心单测（离线）：线协议、envelope 渲染、动作校验怪癖、cell 记账。
 * 用法：node test/cu-core.test.js
 */
const Module = require('node:module');
const path = require('node:path');

const stub = {
  window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const OUT = path.join(__dirname, '..', 'out', 'cu');
const wire = require(path.join(OUT, 'wire.js'));
const env = require(path.join(OUT, 'envelope.js'));
const { ComputerUse, CuError, coordinate, scrollDelta, waitSeconds, normalizeKey } = require(path.join(OUT, 'actions.js'));
const { CellExecutor, sanitizeArgs } = require(path.join(OUT, 'cell.js'));
const { MockBackend } = require(path.join(OUT, 'backend.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ' → ' + detail : ''}`);
  }
}
function throws(name, fn, code) {
  try {
    fn();
    check(name, false, '没有抛错');
  } catch (err) {
    check(name, !code || err.code === code, `${err.code || err.name}: ${err.message}`);
  }
}

/* ---------------- 线协议 ---------------- */
{
  const frame = wire.encodeFrame(Buffer.from('hello'));
  check('帧：魔数 GACF', frame.subarray(0, 4).toString() === 'GACF');
  check('帧：长度小端', frame.readUInt32LE(4) === 5);
  const dec = wire.decodeFrame(frame);
  check('帧：往返一致', dec && dec.frame.payload.toString() === 'hello' && dec.rest.length === 0);
  check('帧：数据不足返回 undefined', wire.decodeFrame(Buffer.from('GAC')) === undefined);

  const cmd = wire.encodeCommand(wire.ModuleId.computerUseWindows, wire.Command.Click, { x: 500, y: 250 });
  const decCmd = wire.decodeCommand(cmd);
  check('命令：version=1', decCmd.version === 1);
  check('命令：module=2', decCmd.moduleId === 2);
  check('命令：commandId=5', decCmd.commandId === 5);
  check('命令：参数往返', decCmd.params.x === 500 && decCmd.params.y === 250);
  check('命令：JSON 紧凑无空格', decCmd.rawJson === '{"x":500,"y":250}', decCmd.rawJson);

  const resp = wire.encodeResponse(0, Buffer.from('{"ok":true}'));
  const decResp = wire.decodeResponse(resp);
  check('响应：status=0', decResp.status === 0);
  throws('响应：多余字节报错', () => wire.decodeResponse(Buffer.concat([resp, Buffer.from([1])])), 'WIRE_EXCESS_DATA');

  // 截图响应：PNG 最小化构造（签名 + IHDR）
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  const shot = wire.decodeScreenshotResponse(wire.decodeResponse(wire.encodeScreenshotResponse(640, 480, png)));
  check('截图：宽高与 PNG 一致', shot.width === 640 && shot.height === 480);
  check('截图：PNG 字节一致', shot.png.equals(png));

  const bad = Buffer.from(wire.encodeScreenshotResponse(640, 480, png));
  // 把 JSON 里的 width 改坏 → 双份校验应失败
  const text = bad.toString('latin1').replace('"width":640', '"width":641');
  throws('截图：双份尺寸不一致报错', () => wire.decodeScreenshotResponse(wire.decodeResponse(Buffer.from(text, 'latin1'))), 'WIRE_SCREENSHOT_SIZE_MISMATCH');
}

/* ---------------- envelope 渲染 ---------------- */
{
  check('截断：保留首 2/3 尾 1/3', env.truncateCounted('a'.repeat(1000), 100).includes('characters cut'));
  check('状态：timeout 优先', env.resultStatus({ ok: false, timed_out: true, exc: null }) === 'timeout');
  check('状态：state_changed 映射', env.resultStatus({ ok: false, timed_out: false, exc: { type: 'E', message: 'm', code: 'CU_WINDOW_GONE' } }) === 'state_changed');
  check('状态：invalid_action 映射', env.resultStatus({ ok: false, timed_out: false, exc: { type: 'E', message: 'm', code: 'CU_BAD_HOTKEY' } }) === 'invalid_action');
  check('状态：兜底 error', env.resultStatus({ ok: false, timed_out: false, exc: { type: 'ValueError', message: 'x' } }) === 'error');
  check('稳定码：合法', env.isStableCode('CU_INVALID_ACTION'));
  check('稳定码：非法', !env.isStableCode('bad code'));
  check('兜底码：CamelCase → PY_', env.fallbackCode('ValueError') === 'PY_VALUE_ERROR');

  const cell = new CellExecutor();
  cell.record('cu', 'click', [500, 300]);
  cell.addText('screen', 'hello');
  const rendered = env.blocksToText(
    env.renderEnvelope(
      cell.toEnvelope({ ok: true, stdout: 'done' }),
    ),
  );
  check('渲染：含 [result status=ok]', rendered.includes('[result status=ok]'), rendered.slice(0, 80));
  check('渲染：含 [progress confirmed=', /\[progress confirmed=0 possible=1\]/.test(rendered), rendered);
  check('渲染：含 [obs scope=screen]', rendered.includes('[obs scope=screen]'));
  check('渲染：含 [next] READY', rendered.includes('[next] READY'));
}

/* ---------------- 动作校验怪癖 ---------------- */
{
  check('坐标：合法数字通过', coordinate('x', 500) === 500);
  check('坐标：不 clamp（1200 原样通过）', coordinate('x', 1200) === 1200);
  throws('坐标：NaN 报错', () => coordinate('x', Number.NaN), 'CU_INVALID_ACTION');
  throws('坐标：字符串报错', () => coordinate('x', '500'), 'CU_INVALID_ACTION');

  check('scroll：数字取整且限 1..10', scrollDelta(3.6).value === 4 && scrollDelta(99).value === 10);
  check('scroll：负数保号', scrollDelta(-4).value === -4);
  check('scroll：up=+5', scrollDelta('up').value === 5 && scrollDelta('up').horizontal === false);
  check('scroll：left 置横向', scrollDelta('left').horizontal === true && scrollDelta('left').value === -5);
  throws('scroll：非法别名报错', () => scrollDelta('diagonal'), 'CU_SCROLL_DELTA');

  check('wait：默认 3 秒', waitSeconds(undefined) === 3);
  throws('wait：超范围报错', () => waitSeconds(181), 'CU_WAIT_SECONDS');
  check('键名：别名归一', normalizeKey('Escape') === 'esc' && normalizeKey('Control') === 'ctrl');
}

/* ---------------- 动作执行（Mock 后端） ---------------- */
(async () => {
  const backend = new MockBackend();
  const cu = new ComputerUse({ backend });

  await cu.click(500, 300);
  check('click：后端收到归一化坐标', backend.calls.some((c) => c.op === 'click' && c.args[0] === 500 && c.args[1] === 300));

  await cu.type('');
  check('type：空串不产生动作', !backend.calls.some((c) => c.op === 'type'));

  await cu.type('你好');
  check('type：记录里不含原文', !cu.executor.actions.some((a) => a.args.some((v) => String(v).includes('你好'))));
  check('type：记录 chars=2', cu.executor.actions.some((a) => a.args[0] === 'chars=2'));

  await cu.hotkey('ctrl', 'c');
  check('hotkey：后端收到 ctrl+c', backend.calls.some((c) => c.op === 'hotkey' && c.args[0] === 'ctrl+c'));
  let bad = false;
  try {
    await cu.hotkey('ctrl+c');
  } catch (err) {
    bad = err.code === 'CU_BAD_HOTKEY';
  }
  check('hotkey：写 "ctrl+c" 报 CU_BAD_HOTKEY', bad);

  await cu.wait(0.01);
  check('wait：不产生动作记录', !cu.executor.actions.some((a) => a.op === 'wait'));

  const shot = await cu.screenshot('t1');
  check('screenshot：落盘返回路径', shot.path.endsWith('.png'));
  check('screenshot：写入图像观察', cu.executor.observations.some((o) => o.kind === 'image' && o.tag === 't1'));

  /* cell 记账：图像超限时级联删除观察 */
  const cell = new CellExecutor();
  for (let i = 0; i < 10; i += 1) {
    cell.addImage(`/tmp/shot-${i}.png`, 10, 10, `s${i}`);
  }
  check('cell：图像最多 8 张', cell.images.length === 8, String(cell.images.length));
  check('cell：被淘汰图像的观察也删除', !cell.observations.some((o) => o.path === '/tmp/shot-0.png' || o.path === '/tmp/shot-1.png'));
  check('cell：记录淘汰计数', cell.imagesDropped === 2, String(cell.imagesDropped));

  /* superseded：后续动作完成后，旧观察过期 */
  const cell2 = new CellExecutor();
  cell2.addText('screen', 'before');
  const act = cell2.record('cu', 'click', [1, 2]);
  cell2.settle(act, true);
  const rendered2 = cell2.toEnvelope({ ok: true });
  check('cell：旧观察被标 superseded', rendered2.observations[0].superseded === true);

  /* 脱敏规则 */
  check('脱敏：hotkey 只留前 8 键', sanitizeArgs('hotkey', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']).length === 8);
  check('脱敏：其它参数最多 4 个', sanitizeArgs('click', [1, 2, 3, 4, 5]).length === 4);
  check('脱敏：长字符串截 80', String(sanitizeArgs('x', ['a'.repeat(200)])[0]).endsWith('...'));

  console.log(`\n[结果] pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
