/**
 * 路径边界测试：.. 逃逸、junction/symlink 逃逸都必须被拒绝。
 * 用法：node test/path-boundary.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

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
const { resolveInsideRoot } = require(path.join(__dirname, '..', 'out', 'config.js'));

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
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-boundary-'));
const root = path.join(base, 'root');
const outside = path.join(base, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);
fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
const link = path.join(root, 'link');
let linked = false;
try {
  fs.symlinkSync(outside, link, 'junction');
  linked = true;
} catch (err) {
  console.log('  SKIP  junction 创建失败：' + err.message);
}

check('普通相对路径通过', resolveInsideRoot(root, 'ok.txt') === path.join(root, 'ok.txt'));
check('.. 逃逸被拒绝', throws(() => resolveInsideRoot(root, '../outside/secret.txt')));
check('绝对路径越界被拒绝', throws(() => resolveInsideRoot(root, path.join(outside, 'secret.txt'))));
check('根目录自身通过', resolveInsideRoot(root, '.') === root);
if (linked) {
  check('junction 逃逸被拒绝', throws(() => resolveInsideRoot(root, 'link/secret.txt')));
  check('junction 下新文件也被拒绝', throws(() => resolveInsideRoot(root, 'link/new.txt')));
  check('junction 根目录自身被拒绝', throws(() => resolveInsideRoot(root, 'link')));
}

try {
  if (linked) {
    fs.rmdirSync(link);
  }
  fs.rmSync(base, { recursive: true, force: true });
} catch (err) {
  console.log('  WARN  清理失败：' + err.message);
}

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
