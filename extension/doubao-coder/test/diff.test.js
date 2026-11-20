/** 行级 diff hunk：拆分、选中应用。 */
'use strict';
const { computeHunks, applyHunks } = require('../out/chat/diff.js');
let pass = 0; let fail = 0;
function check(name, cond, detail) { if (cond) { pass += 1; console.log('  PASS  ' + name); } else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); } }

check('相同内容：无 hunk', computeHunks('a\nb', 'a\nb').length === 0);
const rep = computeHunks('a\nb\nc', 'a\nB\nc');
check('替换：一个 hunk', rep.length === 1 && rep[0].oldLines.join(',') === 'b' && rep[0].newLines.join(',') === 'B');
check('替换：全部接受', applyHunks('a\nb\nc', rep, [0]) === 'a\nB\nc');
check('替换：全部拒绝', applyHunks('a\nb\nc', rep, []) === 'a\nb\nc');
const ins = computeHunks('a\nc', 'a\nb\nc');
check('插入：应用', applyHunks('a\nc', ins, [0]) === 'a\nb\nc');
const del = computeHunks('a\nb\nc', 'a\nc');
check('删除：应用', applyHunks('a\nb\nc', del, [0]) === 'a\nc');
const multi = computeHunks('a\nb\nc\nd\ne\nf', 'a\nB\nc\nd\ne\nF');
check('多块：两个 hunk', multi.length === 2);
check('多块：只接受第二个', applyHunks('a\nb\nc\nd\ne\nf', multi, [1]) === 'a\nb\nc\nd\ne\nF');
check('多块：都接受', applyHunks('a\nb\nc\nd\ne\nf', multi, [0, 1]) === 'a\nB\nc\nd\ne\nF');

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);