/** 样式回归：执行中标题的右侧渐隐 + 颜色过渡、图标尺寸。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.css'), 'utf8');
let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

function rule(selector) {
  const at = css.indexOf(selector + ' {');
  if (at < 0) return '';
  const end = css.indexOf('}', at);
  return css.slice(at, end + 1);
}

const title = rule('.ast-step-title');
check('标题：超长不是省略号而是右侧渐隐（mask）', title.includes('mask-image') && title.includes('linear-gradient'), title.slice(0, 200));
check('标题：完成态用前景色（白/黑），不随状态变色', title.includes('color: var(--db-fg)') && !title.includes('transition: color'), title.slice(0, 200));
check('标题：不再用 text-overflow: ellipsis', !title.includes('ellipsis'), title.slice(0, 200));

const running = rule('.ast-step.is-running .ast-step-title');
check('执行中标题：高亮/亮色，不再用蓝色', running.includes('color: var(--db-fg)') && !running.includes('#4c8bf5') && running.includes('mask-image'), running.slice(0, 200));
check('执行中步骤：高亮底色区分', /\.ast-step\.is-running \{[^}]*background:/.test(css));
check('全局步骤：不使用蓝色', !css.includes('#4c8bf5'));
check('执行过程：统一背景卡片', /\.ast-steps \{[^}]*background:/.test(css) && /\.ast-steps \{[^}]*border-radius/.test(css));
check('执行中条目：三点跳动动效', css.includes('.ast-step-dots') && css.includes('@keyframes ast-dot') && css.includes('.ast-step-dots i:nth-child(2)'));
check('动效：尊重 reduced-motion', css.includes('prefers-reduced-motion'));

const iconSvg = rule('.ast-step-icon svg');
check('图标：SVG 14×14、描边 1.35', iconSvg.includes('width: 14px') && iconSvg.includes('height: 14px') && iconSvg.includes('stroke-width: 1.35'), iconSvg.slice(0, 200));

const js = fs.readFileSync(path.join(__dirname, '..', 'media', 'chat.js'), 'utf8');
check('执行过程：用户上翻时更新不再拽到底部', js.includes('wasNearBottom') && js.includes('if (wasNearBottom)'));
check('执行过程：更新后恢复列表内部滚动位置', js.includes('nextStepsBody') && js.includes('prevStepsScroll'));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);