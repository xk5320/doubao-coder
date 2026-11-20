/**
 * Win32 后端真机冒烟：截图尺寸、剪贴板往返（读完恢复原值）。
 * 用法：node test/cu-win32.test.js
 * 注意：会真实截屏（只校验尺寸后立即删除文件）与读写剪贴板（结束后恢复）。
 */
const Module = require('node:module');
const path = require('node:path');
const { promises: fs } = require('node:fs');

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

const { WindowsCuBackend } = require(path.join(__dirname, '..', 'out', 'cu', 'backend.js'));

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

(async () => {
  const backend = new WindowsCuBackend();

  console.log('=== 截图 ===');
  const started = Date.now();
  const shot = await backend.screenshot();
  console.log(`  ${shot.width}x${shot.height}, ${(shot.png.length / 1024).toFixed(0)} KB, ${Date.now() - started}ms`);
  check('截图尺寸 > 0', shot.width > 0 && shot.height > 0, `${shot.width}x${shot.height}`);
  check('是 PNG（魔数）', shot.png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
  check('虚拟桌面高度合理（>=600）', shot.height >= 600, String(shot.height));

  console.log('=== 剪贴板往返 ===');
  const original = await backend.clipboardGet();
  console.log(`  原内容长度：${original.length}`);
  const token = `doubao-cu-test-${Date.now()}`;
  await backend.clipboardSet(token);
  const readBack = await backend.clipboardGet();
  check('写入后能读回', readBack.trim() === token, readBack.slice(0, 40));
  await backend.clipboardSet(original);
  const restored = await backend.clipboardGet();
  check(
    '已恢复原内容',
    restored === original || restored.trim() === original.trim(),
    `original=${JSON.stringify(original.slice(0, 20))} restored=${JSON.stringify(restored.slice(0, 20))}`,
  );

  console.log('=== 应用列表 ===');
  const apps = await backend.listApps();
  console.log(`  识别到 ${apps.length} 个开始菜单应用，示例：${apps.slice(0, 3).map((a) => a.name).join(', ')}`);
  check('应用列表非空', apps.length > 0, String(apps.length));

  console.log(`\n[结果] pass=${pass} fail=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
