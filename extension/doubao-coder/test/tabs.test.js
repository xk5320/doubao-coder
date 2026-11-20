/** 标签页管理：新增/去重/关闭激活/恢复/切换中止/标题刷新。 */
'use strict';
const { addTab, removeTab, nextActiveAfterClose, restoreTabs, shouldAbortOnSwitch, refreshTitle, MAX_TABS } = require('../out/chat/tabs.js');
let pass = 0; let fail = 0;
function check(name, cond, detail) { if (cond) { pass += 1; console.log('  PASS  ' + name); } else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); } }

// 新增 / 去重 / 上限
check('新建任务：加入标签', addTab([], 'a').join(',') === 'a');
check('再新建：追加到末尾', addTab(['a'], 'b').join(',') === 'a,b');
check('重复打开：不新增、顺序不变', addTab(['a', 'b'], 'a').join(',') === 'a,b');
check('切换标签不改顺序（ensure 只追加）', addTab(addTab(['a', 'b'], 'c'), 'a').join(',') === 'a,b,c');
check('上限 12：丢最旧', addTab(Array.from({ length: 12 }, (_, i) => 't' + i), 'new').length === MAX_TABS && addTab(Array.from({ length: 12 }, (_, i) => 't' + i), 'new')[0] === 't1');
check('空 id：不变', addTab(['a'], '').join(',') === 'a');

// 关闭
check('关闭非激活：激活不变', nextActiveAfterClose(['a', 'b'], 'a', 'b') === 'b');
check('关闭中间激活：取右侧', nextActiveAfterClose(['a', 'b', 'c'], 'b', 'b') === 'c');
check('关闭最后一个激活：取左侧', nextActiveAfterClose(['a', 'b', 'c'], 'c', 'c') === 'b');
check('关闭唯一标签：清空', nextActiveAfterClose(['a'], 'a', 'a') === '');
check('关闭不存在标签：激活不变', nextActiveAfterClose(['a'], 'x', 'a') === 'a');
check('removeTab 只删一个', removeTab(['a', 'b', 'a'], 'a').join(',') === 'b');

// 恢复
const exists = (id) => ['a', 'c'].includes(id);
check('恢复：过滤已删会话', restoreTabs(['a', 'gone', 'c'], exists, 'a').join(',') === 'a,c');
check('恢复：去重', restoreTabs(['a', 'a'], exists, 'a').join(',') === 'a');
check('恢复：当前会话补到末尾', restoreTabs(['a'], exists, 'c').join(',') === 'a,c');
check('恢复：空持久化仍有当前', restoreTabs([], exists, 'a').join(',') === 'a');
check('恢复：上限', restoreTabs(Array.from({ length: 20 }, (_, i) => 'x' + i), () => true, '').length === MAX_TABS);

// 切换中止
check('切换：忙碌且换标签要中止', shouldAbortOnSwitch(true, 'a', 'b') === true);
check('切换：空闲不中止', shouldAbortOnSwitch(false, 'a', 'b') === false);
check('切换：同一标签不中止', shouldAbortOnSwitch(true, 'a', 'a') === false);

// 标题刷新
const r1 = refreshTitle({ currentTitle: '旧标题', currentDesktopTitle: '旧标题', nextTitle: '豆包标题', nextDesktopId: 'id1' });
check('标题：名字变化算改动', r1.changed && r1.title === '豆包标题' && r1.desktopTitle === '豆包标题');
const r2 = refreshTitle({ currentTitle: '豆包标题', currentDesktopTitle: '豆包标题', currentDesktopId: 'id1', nextTitle: '豆包标题', nextDesktopId: 'id1' });
check('标题：完全一致不算改动', r2.changed === false);
const r3 = refreshTitle({ currentTitle: '豆包标题', currentDesktopTitle: '豆包标题', currentDesktopId: 'id1', nextTitle: '豆包标题', nextDesktopId: 'id2' });
check('标题：desktopId 变化算改动', r3.changed === true);
check('标题：空标题不算改动', refreshTitle({ nextTitle: '   ' }).changed === false);
console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);