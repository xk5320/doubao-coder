/* 定时同步器实测：连真实豆包窗口，跑 8 秒，验证能拿到快照并推送。 */
const path = require('node:path');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'vscode') {
    return { window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) } };
  }
  return origLoad.apply(this, arguments);
};

const { SyncPoller } = require(path.join(__dirname, '..', 'out', 'bridge', 'sync-poller.js'));

(async () => {
  const snaps = [];
  let poller;
  try {
    poller = await SyncPoller.start({
      intervalMs: 800,
      idleStopCount: 999, // 测试期间不要自动停
      onSnapshot: (snap) => snaps.push(snap),
    });
  } catch (err) {
    console.log('[FAIL] 启动失败:', err.message);
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 8000));
  poller.stop('测试结束');

  console.log(`收到快照 ${snaps.length} 个（8 秒，间隔 800ms）`);
  if (snaps.length === 0) {
    console.log('[FAIL] 一个快照都没收到');
    process.exit(1);
  }
  const last = snaps[snaps.length - 1];
  const totalChars = last.blocks.reduce((sum, b) => sum + b.text.length, 0);
  const kinds = {};
  for (const b of snaps) {
    for (const block of b.blocks) {
      kinds[block.kind] = (kinds[block.kind] || 0) + 1;
    }
  }
  console.log(`最后一个快照：${last.blocks.length} 块 / ${totalChars} 字符 / working=${last.working} / 已处理=${last.progressSeconds}`);
  console.log('累计块类型:', JSON.stringify(kinds));

  if (snaps.length < 3) {
    console.log('[FAIL] 快照太少，轮询可能没生效');
    process.exit(1);
  }
  console.log('[PASS] 定时同步可用');
})();
