/** 「豆包是不是没回」的判定：只要还在执行/计时，就不能误报没有回复。 */
'use strict';

const { isStalled, stallDecision } = require('../out/bridge/activity.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('已看到正文：不算卡住', isStalled({ sawReply: true, idleMs: 10 * 60_000, busy: false, executing: false }) === false);
check('停止按钮还在：执行/生成中不算卡住', isStalled({ sawReply: false, idleMs: 10 * 60_000, busy: true, executing: false }) === false);
check('正在执行代码：不算卡住', isStalled({ sawReply: false, idleMs: 10 * 60_000, busy: false, executing: true }) === false);
check('90 秒真没动静：算卡住', isStalled({ sawReply: false, idleMs: 91_000, busy: false, executing: false }) === true);
check('不足 90 秒：还不算', isStalled({ sawReply: false, idleMs: 30_000, busy: false, executing: false }) === false);
check('阈值可调：60 秒', isStalled({ sawReply: false, idleMs: 61_000, busy: false, executing: false, thresholdMs: 60_000 }) === true);

const stalled = { sawReply: false, idleMs: 91_000, busy: false, executing: false };
check('没动静第 1 次：先重试', stallDecision({ ...stalled, retries: 0, maxRetries: 2 }) === 'retry');
check('没动静第 2 次：再重试', stallDecision({ ...stalled, retries: 1, maxRetries: 2 }) === 'retry');
check('重试完仍没动静：才提示', stallDecision({ ...stalled, retries: 2, maxRetries: 2 }) === 'give-up');
check('有活动：不重试也不提示', stallDecision({ sawReply: true, idleMs: 0, busy: false, executing: false, retries: 2 }) === 'ok');
check('执行中：不重试也不提示', stallDecision({ sawReply: false, idleMs: 0, busy: true, executing: false, retries: 2 }) === 'ok');

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);