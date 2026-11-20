/**
 * Webview 结构测试：本地电脑模式工具栏的 DOM id 必须存在，chat.js 语法必须合法。
 * 用法：node test/webview-mode.test.js
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const stub = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (key, d) => (key === 'chat.mode' ? 'local' : d), update: async () => undefined }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    workspaceFolders: [{ uri: { fsPath: 'D:\\rex86' }, name: 'rex86' }],
    isTrusted: true,
  },
  Uri: {
    file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }),
    joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts), scheme: 'file', toString: () => path.join(base.fsPath, ...parts) }),
  },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  commands: { executeCommand: async () => undefined },
  env: { clipboard: { writeText: async () => undefined } },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return stub;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { ChatViewProvider } = require(path.join(__dirname, '..', 'out', 'chat', 'panel.js'));

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

const memento = { get: () => undefined, update: async () => undefined, keys: () => [] };
const context = { extensionUri: stub.Uri.file(path.join(__dirname, '..')), subscriptions: [], workspaceState: memento, globalState: memento };
const provider = new ChatViewProvider(context, () => undefined);
const mediaRoot = stub.Uri.file(path.join(__dirname, '..', 'media'));
const webview = { cspSource: 'vscode-resource:', asWebviewUri: (uri) => uri };
const html = provider.getHtml(webview, mediaRoot);

check('HTML：模式按钮', html.includes('id="chip-mode"') && html.includes('本地电脑'));
check('HTML：新任务按钮', html.includes('id="btn-task"'));
check('HTML：顶栏顺序 对话→任务→历史', html.indexOf('id="btn-new"') < html.indexOf('id="btn-task"') && html.indexOf('id="btn-task"') < html.indexOf('id="btn-history"'));
check('HTML：权限按钮', html.includes('id="chip-permission"') && html.includes('按需确认'));
check('HTML：项目 chip', html.includes('id="chip-project"'));
check('HTML：插件 chip', html.includes('id="chip-plugins"'));
check('HTML：对话生成能力', html.includes('data-chat-action="image"') && html.includes('data-chat-action="video"') && html.includes('data-chat-action="ppt"'));
check('HTML：历史管理面板', html.includes('id="history-overlay"') && html.includes('id="history-list"'));
check('HTML：历史批量操作', html.includes('id="history-batch"') && html.includes('id="history-batch-delete"'));
check('HTML：上传/更多按钮', html.includes('id="btn-plus"'));
check('HTML：技能 chip', html.includes('id="chip-skills"'));
check('HTML：模型 chip', html.includes('id="chip-model"'));
check('HTML：CSP nonce', /script-src 'nonce-[A-Za-z0-9]{32}'/.test(html));

const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
check('chat.js：按模式显隐技能/插件', js.includes('quickChatEl.hidden = local') && js.includes('chipPlugins.hidden = !local'));
const { readLastReplyJs } = require(path.join(__dirname, '..', 'out', 'bridge', 'md-extractor.js'));
const reader = readLastReplyJs('a', 'b');
check('chat.js：包含 setMode 消息', js.includes("type: 'setMode'"));
check('chat.js：包含 setPermission 消息', js.includes("type: 'setPermission'"));
check('chat.js：包含插件/技能/模型点击', js.includes("type: 'listPlugins'") && js.includes("type: 'listSkills'") && js.includes("type: 'listModels'"));
check('chat.js：模式按钮显示本地电脑', js.includes('chipMode.textContent') && js.includes("本地电脑"));
check('chat.js：桌面模式/推理消息', js.includes("type: 'setDesktopMode'") && js.includes("type: 'setReasoning'"));
check('chat.js：图片消息渲染', js.includes("case 'image'") && js.includes("'msg-image'"));
check('chat.js：打开原图消息', js.includes("type: 'openExternal'"));

check('图片提取：读取 message_image_content', reader.includes('message_image_content'));
check('图片提取：缩略图与原图', reader.includes('cthumb') && reader.includes('cgen_lwm3'));
check('图片提取：返回 images', reader.includes('images: images.slice'));

const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const cmdIds = (pkgJson.contributes.commands || []).map(function (c) { return c.command; });
check('选区命令：重构/测试/修复已注册', ['doubao.refactorSelection', 'doubao.writeTests', 'doubao.fixDiagnostics'].every(function (id) { return cmdIds.indexOf(id) >= 0; }));
const ctxMenus = ((pkgJson.contributes.menus || {})['editor/context'] || []).map(function (m) { return m.command; });
check('选区命令：出现在编辑器右键菜单', ['doubao.explainSelection', 'doubao.refactorSelection', 'doubao.writeTests', 'doubao.fixDiagnostics'].every(function (id) { return ctxMenus.indexOf(id) >= 0; }));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
