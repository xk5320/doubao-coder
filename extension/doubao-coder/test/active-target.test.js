/** ActiveTarget 纯函数：标题归一化 / 匹配优先级 / 恢复判定。 */
'use strict';

const {
  normalizeTitle, titleKey, matchConversation, desktopTarget, localTarget, noneTarget,
  activeDesktopTitle, shouldRestoreLastWindow, hasConversation,
} = require('../out/chat/active-target.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('归一化：全角空格/连续空白', normalizeTitle('  A\u3000\u3000B  ') === 'A B', normalizeTitle('  A\u3000\u3000B  '));
check('归一化：换行压缩', normalizeTitle('A\n B') === 'A B', normalizeTitle('A\n B'));
check('key：忽略大小写', titleKey('AbC') === 'abc');

const items = [
  { index: 0, title: '移植TS工程到Unity工程' },
  { index: 1, title: '生成图片' },
  { index: 2, title: '移植TS工程到Unity工程（旧）' },
  { index: 3, title: '生成图片2' },
];
check('匹配：精确', matchConversation('生成图片', items).item.index === 1);
check('匹配：忽略空白/大小写', matchConversation(' 生成图片 ', items).item.index === 1);
check('匹配：前缀唯一', matchConversation('移植TS工程到Unity工程（旧', items).item.index === 2);
check('匹配：找不到', matchConversation('不存在的对话', items).error === 'not-found');
check('匹配：禁止任意子串', matchConversation('Unity', items).error === 'not-found');

const dup = [
  { index: 0, title: '同名对话' },
  { index: 1, title: '同名对话' },
];
const dupResult = matchConversation('同名对话', dup);
check('匹配：同名取最近并标记 ambiguous', dupResult.item.index === 0 && dupResult.error === 'ambiguous');

check('目标：desktop 标题归一', activeDesktopTitle(desktopTarget('  A  B ')) === 'A B');
check('目标：local 带 desktopTitle', activeDesktopTitle(localTarget('s1', '对话 A')) === '对话 A');
check('目标：none 无标题', activeDesktopTitle(noneTarget()) === '');

check('恢复：有激活不恢复', shouldRestoreLastWindow({ savedTitle: 'A', savedAt: 10, hasActiveTarget: true }) === false);
check('恢复：保存晚于用户操作才恢复', shouldRestoreLastWindow({ savedTitle: 'A', savedAt: 20, userActivatedAt: 10 }) === true);
check('恢复：用户操作晚于保存不恢复', shouldRestoreLastWindow({ savedTitle: 'A', savedAt: 10, userActivatedAt: 20 }) === false);
check('恢复：空标题不恢复', shouldRestoreLastWindow({ savedTitle: '  ' }) === false);

check('对账：对话仍存在', hasConversation('生成图片', items) === true);
check('对账：对话已不存在', hasConversation('已删除的对话', items) === false);
check('对账：空白标题视为不存在', hasConversation('  ', items) === false);

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);