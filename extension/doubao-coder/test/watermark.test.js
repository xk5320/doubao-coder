/** 初始化无水印：配置、命令、自动化路径的源码契约。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

const config = read('src/config.ts');
check('配置：applyNoWatermark 默认开', config.includes("applyNoWatermark: asBool(cfg.get<boolean>('applyNoWatermark'), true)"));

const pkg = JSON.parse(read('package.json'));
const settings = pkg.contributes.configuration.properties;
check('设置项：doubao.applyNoWatermark 默认 true', settings['doubao.applyNoWatermark'] && settings['doubao.applyNoWatermark'].default === true);
check('命令：已注册', pkg.contributes.commands.some((c) => c.command === 'doubao.applyNoWatermark'));
check('激活事件：已声明', pkg.activationEvents.includes('onCommand:doubao.applyNoWatermark'));

const wm = read('src/doubao/watermark.ts');
check('自动化：两行目标齐全', wm.includes('生成的文档、表格、PPT') && wm.includes('生成的图片、视频'));
check('自动化：走设置入口', wm.includes('sidebar_footer_setting_entry') && wm.includes('settings-category-general'));
check('自动化：开关按 aria-checked 判断', wm.includes('aria-checked') && wm.includes('role="switch"'));
check('自动化：只用无水印，不会去开启水印', wm.includes('if (!checked)') && wm.includes('toggleSwitch'));
check('自动化：结束关闭设置', wm.includes('setting-modal-close'));

const ext = read('src/extension.ts');
check('初始化：调用并写一次性标记', ext.includes('applyNoWatermark(config.desktopPort)') && ext.includes('doubao.noWatermarkApplied'));
check('命令：可手动重跑', ext.includes("registerCommand('doubao.applyNoWatermark'"));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);