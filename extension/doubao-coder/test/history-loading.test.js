/** 历史面板：必须有“正在加载豆包对话…”的进度与失败重试。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const chat = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'src', 'chat', 'panel.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('打开历史：进入 loading 状态', chat.includes('historyLoading = true'));
check('历史消息：支持 loading 字段', chat.includes('historyLoading = Boolean(message.loading)'));
check('加载中：显示「正在加载豆包对话列表…」', chat.includes('正在加载豆包对话列表'));
check('加载指示：复用旋转 spinner', chat.includes("el('div', 'history-loading')"));
check('失败：显示错误 + 重试按钮', chat.includes("'重试'") && chat.includes("type: 'listHistory'"));
check('首次加载：本地为空时自动切到豆包对话', chat.includes("historyTab === 'local' && !(historyData.local || []).length"));

check('面板：先发 loading:true', panel.includes("type: 'historyMenu', loading: true"));
check('面板：完整同步并显示进度', panel.includes('collectAllDesktopConversations') && panel.includes('正在同步豆包对话…（已 '));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);