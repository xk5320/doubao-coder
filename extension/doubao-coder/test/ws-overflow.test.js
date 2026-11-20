/**
 * WebSocket 帧长度溢出：不能把异常抛进 socket data 回调（否则扩展宿主未捕获异常）。
 * 用法：node test/ws-overflow.test.js
 */
const path = require('node:path');
const { MiniWebSocket } = require(path.join(__dirname, '..', 'out', 'bridge', 'ws.js'));

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  PASS  ' + name);
  } else {
    fail += 1;
    console.log('  FAIL  ' + name + (detail ? ' → ' + detail : ''));
  }
}

const writes = [];
const fakeSocket = {
  writable: true,
  write: (buf) => { writes.push(buf); return true; },
  end: () => { fakeSocket.ended = true; },
  destroy: () => {},
  on: () => fakeSocket,
};
const ws = new MiniWebSocket(fakeSocket);
let emitted = '';
ws.on('error', (err) => { emitted = err.message; });

// 0x82 文本帧 + 0xFF（127 长度）+ 8 字节大端 4GB
const header = Buffer.from([0x82, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
let threw = false;
try {
  ws.onData(header);
} catch {
  threw = true;
}
check('溢出帧：onData 不抛异常', threw === false);
check('溢出帧：emit error', emitted.includes('帧过大'), emitted);
check('溢出帧：连接被关闭', ws.closed === true || fakeSocket.ended === true);
check('溢出帧：缓冲区被清空', ws.buffer.length === 0, 'len=' + ws.buffer.length);

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exitCode = fail === 0 ? 0 : 1;
