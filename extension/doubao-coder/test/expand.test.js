/** 源码契约：执行过程的展开路径必须存在（回合结束 / 空闲停止前 / 旁观时）。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const src = path.join(__dirname, '..', 'src');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

const extractor = fs.readFileSync(path.join(src, 'bridge', 'md-extractor.ts'), 'utf8');
check('展开：认 aria-expanded=false（不只看 data 属性）', extractor.includes("aria-expanded=\"false\""));
check('展开：跳过 disabled 的按钮', extractor.includes('btn.disabled'));

const poller = fs.readFileSync(path.join(src, 'bridge', 'sync-poller.ts'), 'utf8');
check('同步：每 tick 展开一次', poller.includes('await this.session.evaluate<number>(expandStepsJs()'));
check('同步：空闲停止前最后展开一次', poller.includes('直接停掉会永远漏掉'));

const desktop = fs.readFileSync(path.join(src, 'bridge', 'desktop.ts'), 'utf8');
check('回合结束：收尾前展开并重读分块', desktop.includes('收尾前再展开一次'));
check('旁观：每轮展开一次', desktop.includes('expandStepsJs(), 3000'));

const panel = fs.readFileSync(path.join(src, 'chat', 'panel.ts'), 'utf8');
check('资源缓存：css/js 带版本号', panel.includes('query: `v=${version}`'));
check('面板：state 里带版本号', panel.includes('version: this.extensionVersion()'));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);