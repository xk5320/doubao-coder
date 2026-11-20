/**
 * PTC 解析器离线单测（不联网、不发消息）。
 * 用法：node test/ptc-parser.test.js
 */
const path = require('node:path');

/* 纯解析用例不该依赖 VS Code 运行时；装一个最小桩，避免 require('vscode') 失败。 */
const Module = require('node:module');
const stub = {
  window: { createOutputChannel: () => ({ appendLine: () => undefined, show: () => undefined, dispose: () => undefined }) },
  workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose: () => undefined }) },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { parsePtc, visibleProse } = require(path.join(__dirname, '..', 'out', 'agent', 'ptc.js'));

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

const FENCE = String.fromCharCode(96, 96, 96);

/* 1) 单个工具块 + 说明文字 */
{
  const text = [
    '我先看看工程结构。',
    '',
    FENCE + 'tool',
    '{"name":"list_dir","arguments":{"path":"."}}',
    FENCE,
    '',
    '拿到结果再决定。',
  ].join('\n');
  const r = parsePtc(text);
  check('单块：解析出 1 个调用', r.calls.length === 1, JSON.stringify(r.calls));
  check('单块：name 正确', r.calls[0].name === 'list_dir');
  check('单块：参数正确', r.calls[0].arguments.path === '.');
  check('单块：正文不含围栏', !r.prose.includes(FENCE), r.prose);
  check('单块：正文保留说明', r.prose.includes('我先看看工程结构'), r.prose);
  check('单块：未标记 incomplete', r.incomplete === false);
}

/* 2) 一个回复里多个块 */
{
  const text = [
    FENCE + 'tool',
    '{"name":"read_file","arguments":{"path":"a.ts"}}',
    FENCE,
    '中间说明',
    FENCE + 'tool',
    '{"name":"grep","arguments":{"pattern":"TODO"}}',
    FENCE,
  ].join('\n');
  const r = parsePtc(text);
  check('多块：2 个调用', r.calls.length === 2, String(r.calls.length));
  check('多块：顺序正确', r.calls[0].name === 'read_file' && r.calls[1].name === 'grep');
  check('多块：id 唯一', r.calls[0].id !== r.calls[1].id);
  check('多块：中间说明保留', r.prose.includes('中间说明'));
}

/* 3) 未闭合（流式中间态） */
{
  const text = ['已收到，我先读文件：', FENCE + 'tool', '{"name":"read_file","arguments":{"path":"a.ts"}}'].join('\n');
  const r = parsePtc(text);
  check('未闭合：不执行', r.calls.length === 0);
  check('未闭合：incomplete=true', r.incomplete === true);
  check('未闭合：不泄露 JSON', !r.prose.includes('read_file'), r.prose);
  check('未闭合：保留前置正文', r.prose.includes('已收到'));
}

/* 4) args 别名 + JSON 前后有噪音 */
{
  const text = [FENCE + 'ptc', '调用如下： {"name":"read_file","args":{"path":"b.ts"}} 完毕', FENCE].join('\n');
  const r = parsePtc(text);
  check('ptc 语言标记：识别', r.calls.length === 1);
  check('args 别名：兼容', r.calls[0].arguments.path === 'b.ts');
  check('带噪音 JSON: 截取成功', r.calls[0].name === 'read_file');
}

/* 5) 非法 JSON → 记为错误调用，不抛出 */
{
  const text = [FENCE + 'tool', 'this is not json', FENCE].join('\n');
  const r = parsePtc(text);
  check('非法 JSON：产生 1 条错误调用', r.calls.length === 1 && Boolean(r.calls[0].error));
}

/* 6) 普通代码块不受影响 */
{
  const text = [FENCE + 'ts', 'const a = 1;', FENCE, '', '以上是要改的代码。'].join('\n');
  const r = parsePtc(text);
  check('普通代码块：不误判', r.calls.length === 0);
  check('普通代码块：正文保留', r.prose.includes('const a = 1'));
}

/* 7) 流式可见文本单调增长 */
{
  const chunks = [
    '好的，',
    '我先看看。\n' + FENCE + 'to',
    'ol\n{"name":"list_dir","argum',
    'ents":{}}\n' + FENCE + '\n完成',
  ];
  let raw = '';
  let last = '';
  let monotonic = true;
  for (const c of chunks) {
    raw += c;
    const v = visibleProse(raw);
    if (!v.startsWith(last)) {
      monotonic = false;
    }
    last = v;
  }
  check('流式：可见文本单调增长', monotonic);
  check('流式：最终不含围栏', !last.includes(FENCE), last);
  check('流式：最终含收尾文字', last.includes('完成'), last);
}

console.log(`\n[结果] pass=${pass} fail=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
