/** 桌面端连接问题分类。 */
'use strict';
const { classifyDesktop } = require('../out/bridge/desktop-errors.js');
let pass = 0; let fail = 0;
function check(name, cond) { if (cond) { pass += 1; console.log('  PASS  ' + name); } else { fail += 1; console.log('  FAIL  ' + name); } }
function code(s) { return classifyDesktop(s).code; }
check('未安装', code({ installed: false, portOpen: false, running: false, loggedIn: false, hasEditor: false }) === 'not-installed');
check('端口未开', code({ installed: true, portOpen: false, running: false, loggedIn: false, hasEditor: false }) === 'port-closed');
check('端口被占用（非 CDP）', code({ installed: true, portOpen: true, running: false, loggedIn: false, hasEditor: false }) === 'port-not-cdp');
check('未登录', code({ installed: true, portOpen: true, running: true, loggedIn: false, hasEditor: false }) === 'not-logged-in');
check('无对话页', code({ installed: true, portOpen: true, running: true, loggedIn: true, hasEditor: false }) === 'no-page');
check('就绪', code({ installed: true, portOpen: true, running: true, loggedIn: true, hasEditor: true }) === 'ok');
check('提示文案非空', classifyDesktop({ installed: false, portOpen: false, running: false, loggedIn: false, hasEditor: false }).hint.length > 8);
console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);