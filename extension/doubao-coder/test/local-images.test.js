/** 本地图片路径 → data URL，保证 webview 能预览。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const panel = fs.readFileSync(path.join(root, 'src', 'chat', 'panel.ts'), 'utf8');
const extractor = fs.readFileSync(path.join(root, 'src', 'bridge', 'md-extractor.ts'), 'utf8');
const blocks = fs.readFileSync(path.join(root, 'src', 'bridge', 'blocks.ts'), 'utf8');
const mod = fs.readFileSync(path.join(root, 'src', 'chat', 'local-images.ts'), 'utf8');
const { convertLocalImages, localImagePath } = require('../out/chat/local-images.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('面板：有本地图片转换', panel.includes('private localizeBlocks<T>') && panel.includes('convertLocalImages'));
check('模块：括号配对扫描', mod.includes('depth += 1') && mod.includes('depth -= 1'));
const withParens = convertLocalImages('![a](D:\\art\\英雄-铁骑 (SR) .png)', (p) => 'data:image/png;base64,X' + p.length);
check('路径含括号/空格：能替换', withParens.indexOf('data:image/png;base64') >= 0 && withParens.indexOf('(SR)') < 0, withParens.slice(0, 80));
const angle = convertLocalImages('![a](<D:\\a b\\c.png>)', () => 'data:image/png;base64,Y');
check('尖括号包裹：能替换', angle.indexOf('data:image/png;base64,Y') >= 0, angle.slice(0, 80));
check('相对路径：交给读取器解析', convertLocalImages('![a](parity-step-1.png)', (p2) => 'data:image/png;base64,R' + p2.length).indexOf('data:image/png;base64') >= 0);
check('http 图片不动', convertLocalImages('![a](https://x/a.png)', () => 'data:image/png;base64,Z') === '![a](https://x/a.png)');
check('localImagePath：盘符', localImagePath('D:\\a b\\c.png') === 'D:\\a b\\c.png');
check('模块：file:// 与盘符都处理', mod.includes('file:\\/\\/') && mod.includes('^[A-Za-z]:'));
check('面板：转成 data URL', panel.includes('data:${type};base64'));
check('面板：调用 Markdown 图片替换', panel.includes('convertLocalImages(next.text'));
check('面板：所有 blocks 推送都转换', (panel.split('localizeBlocks(').length - 1) >= 3);
check('面板：流式增量也转换', panel.includes('localizeText(delta)') && panel.includes('localizeText(text)'));
check('面板：ast 通道也转换', panel.includes('localizeBlocks(parseMarkdownBlocks'));
check('面板：image 消息也转换', panel.includes('private postImage') && panel.includes('postImage(image)'));
check('提取：允许 file: 图片', extractor.includes('data:|file:'));
check('提取：md 转换器版本已升级', extractor.includes('__dcMdVersion === 5') && extractor.includes('__dcMdVersion = 5'));
check('归一化：允许 file: 图片', blocks.includes('data:|file:'));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);