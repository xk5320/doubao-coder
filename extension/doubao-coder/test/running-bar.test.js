/** 输入框上方的「正在执行中」状态条。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'src', 'chat', 'panel.ts'), 'utf8');
const chat = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'media', 'chat.css'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('页面：输入框上方有状态条', panel.includes('id="running-bar"') && panel.includes('id="running-text"'));
check('页面：状态条不再放「继续说」按钮', !panel.includes('running-continue'));
check('状态条只显示执行状态', panel.includes('id="running-text"'));
check('样式：状态条与按钮', css.includes('.running-bar') && css.includes('.running-continue'));
check('忙时显示状态条', chat.includes('showRunningBar()') && chat.includes('if (busy)'));
check('状态同步时更新时间', chat.includes('showRunningBar(secs)'));
check('结束/清空时隐藏', chat.includes('hideRunningBar()') && chat.includes('if (finished)'));
check('每秒刷新用时', chat.includes('setInterval(paintRunningBar, 1000)'));
check('「继续说」只做提示、不预填', chat.includes('继续说：让豆包接着当前任务继续') && !chat.includes("inputEl.value = '继续说'"));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);