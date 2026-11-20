/** 面板切到「对话」后，发送必须也走对话模式，不能被 desktop.workMode=local 拉回去。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'chat', 'panel.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('切模式时同时落盘 desktop.workMode', panel.includes("update('desktop.workMode', mode"));
check('统一解析模式：auto 跟随 chat.mode', panel.includes('private desktopModeFor(config: DoubaoConfig)') && panel.includes("config.chatMode === 'local' ? 'local' : 'chat'"));
const rd = panel.indexOf('private async runDesktop');
const rdEnd = panel.indexOf('private async runAgent');
const body = rd >= 0 && rdEnd > rd ? panel.slice(rd, rdEnd) : '';
check('runDesktop 使用统一解析', body.indexOf('const desktopMode = this.desktopModeFor(config)') >= 0 && body.indexOf('ensureDesktopWorkMode(desktopMode)') >= 0);
check('runDesktop 不再直接按 desktopWorkMode 猜', body.indexOf("config.desktopWorkMode === 'local' ? 'local' : 'chat'") < 0);

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);