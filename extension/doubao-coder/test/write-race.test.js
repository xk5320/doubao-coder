/**
 * 写入竞态测试：读取后文档被用户修改，必须取消写入而不是静默覆盖。
 * 用法：node test/write-race.test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

let docText = 'old-content';
let applied = 0;
let mutateOnRemember = false;

class Position { constructor(line, character) { this.line = line; this.character = character; } }
class Range { constructor(start, end) { this.start = start; this.end = end; } }
const uri = { fsPath: '', scheme: 'file', path: '', toString: () => 'file://' + uri.fsPath };
const doc = {
  uri,
  version: 1,
  getText: (range) => (range ? docText : docText),
  positionAt: (offset) => ({ offset }),
};

const stub = {
  window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
  workspace: {
    getConfiguration: () => ({ get: () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async () => doc,
    applyEdit: async () => { applied += 1; return true; },
  },
  Uri: { file: (p) => { uri.fsPath = p; uri.path = p; return uri; } },
  Position,
  Range,
  WorkspaceEdit: class { replace() {} createFile() {} },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { replaceWholeFile } = require(path.join(__dirname, '..', 'out', 'agent', 'tools.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doubao-race-'));
const file = path.join(tmp, 'a.ts');
fs.writeFileSync(file, docText);
const context = {
  workspaceState: {
    get: () => undefined,
    update: async () => {
      if (mutateOnRemember) {
        docText = 'user-edited-content';
      }
    },
  },
};

(async () => {
  try {
    /* 1) 快照过期：expectedOldText 不匹配 */
    mutateOnRemember = false;
    docText = 'old-content';
    applied = 0;
    let staleError = '';
    try {
      await replaceWholeFile(context, stub.Uri.file(file), 'new-content', 'write_file', 'stale-snapshot');
    } catch (err) {
      staleError = err.message;
    }
    check('快照过期：抛错', staleError.includes('读取后被修改'), staleError);
    check('快照过期：没有 applyEdit', applied === 0, 'applied=' + applied);

    /* 2) rememberLastEdit 期间用户编辑：第二次检查必须拦住 */
    mutateOnRemember = true;
    docText = 'old-content';
    applied = 0;
    let raceError = '';
    try {
      await replaceWholeFile(context, stub.Uri.file(file), 'new-content', 'write_file');
    } catch (err) {
      raceError = err.message;
    }
    check('竞态：抛错', raceError.includes('写入前被修改'), raceError);
    check('竞态：没有 applyEdit', applied === 0, 'applied=' + applied);

    /* 3) 无冲突：正常写入 */
    mutateOnRemember = false;
    docText = 'old-content';
    applied = 0;
    await replaceWholeFile(context, stub.Uri.file(file), 'new-content', 'write_file');
    check('无冲突：applyEdit 一次', applied === 1, 'applied=' + applied);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
    process.exitCode = fail === 0 ? 0 : 1;
  }
})().catch((err) => {
  console.error('FAILED:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
