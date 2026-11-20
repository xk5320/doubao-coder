/** 标签页选择回归：多标签页时必须优先客户端对话页，而不是隐藏的网页版/官网。 */
'use strict';

const { chatPageCandidates } = require('../out/bridge/cdp.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

function target(url, type) {
  return { id: url, type: type || 'page', title: '', url, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/x' };
}

const desktopChat = target('doubao://doubao-chat/chat/38453736025259778');
const webChat = target('https://www.doubao.com/chat/38453736025259778');
const about = target('https://www.doubao.com/about');
const background = target('doubao://doubao-background/');
const iframe = target('https://www.doubao.com/drive-iframe/drive/home/', 'iframe');
const game = target('http://127.0.0.1:99/');

const mixed = chatPageCandidates([game, about, webChat, desktopChat, background, iframe]);
check('多标签页：只选客户端对话页', mixed.length === 1 && mixed[0].url.startsWith('doubao://doubao-chat/'), 'picked=' + mixed.map((t) => t.url).join(','));
check('多标签页：忽略网页版/官网/背景页/iframe', !mixed.some((t) => /www\.doubao\.com|doubao-background|iframe/.test(t.url)));

const webOnly = chatPageCandidates([game, about, webChat]);
check('没有客户端对话页时：退到网页版对话页', webOnly.length >= 1 && webOnly[0].url.startsWith('https://www.doubao.com/chat/'), 'picked=' + webOnly.map((t) => t.url).join(','));

const twoTabs = chatPageCandidates([desktopChat, target('doubao://doubao-chat/chat/111')]);
check('多个客户端对话页：保留全部候选，交给可见性挑选', twoTabs.length === 2);

const freshChat = target('doubao://doubao-chat/chat');
const withFresh = chatPageCandidates([freshChat, webChat, about]);
check('新建对话后（doubao://doubao-chat/chat）仍算客户端对话页',
  withFresh.length === 1 && withFresh[0].url === 'doubao://doubao-chat/chat',
  'picked=' + withFresh.map((x) => x.url).join(','));

const none = chatPageCandidates([game, about, background]);
check('没有对话页：只在豆包页面里兜底，绝不选游戏页',
  none.length >= 1 && none.every((t) => t.url.includes('doubao')),
  'picked=' + none.map((t) => t.url).join(','));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);