'use strict';
const { parseQrLine } = require('../out/cli/login.js');
let pass = 0; let fail = 0;
function check(n, c) { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n); } }
check('解析 QR_IMAGE 路径', parseQrLine('QR_IMAGE=C:\\temp\\qrcode.png') === 'C:\\temp\\qrcode.png');
check('解析带引号路径', parseQrLine('QR_IMAGE="C:\\a b\\q.png"') === 'C:\\a b\\q.png');
check('非二维码行返回 undefined', parseQrLine('请使用豆包移动端扫码') === undefined);
check('大小写不敏感', parseQrLine('qr_image=/tmp/x.png') === '/tmp/x.png');
console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);