/**
 * 工具参数归一化回归测试：apply_patch 的 old_text/new_text 必须映射到 schema 的 old_string/new_string。
 * 用法：node test/tool-args.test.js
 */
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
const { normalizeToolArgs } = require(path.join(__dirname, '..', 'out', 'agent', 'tools.js'));

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

const alias = normalizeToolArgs('apply_patch', { path: 'a.ts', old_text: 'x', new_text: 'y' });
check('apply_patch：old_text → old_string', alias.old_string === 'x' && alias.old_text === undefined, JSON.stringify(alias));
check('apply_patch：new_text → new_string', alias.new_string === 'y' && alias.new_text === undefined, JSON.stringify(alias));

const canonical = normalizeToolArgs('apply_patch', { path: 'a.ts', old_string: 'x', new_string: 'y' });
check('apply_patch：canonical 参数不变', canonical.old_string === 'x' && canonical.new_string === 'y', JSON.stringify(canonical));

const camel = normalizeToolArgs('apply_patch', { path: 'a.ts', oldText: 'x', newText: 'y' });
check('apply_patch：camelCase → snake_case', camel.old_string === 'x' && camel.new_string === 'y', JSON.stringify(camel));

const file = normalizeToolArgs('read_file', { file_path: 'src/a.ts', startLine: 3 });
check('read_file：file_path/startLine 兼容', file.path === 'src/a.ts' && file.start_line === 3, JSON.stringify(file));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
