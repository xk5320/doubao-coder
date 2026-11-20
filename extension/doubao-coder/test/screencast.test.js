/* M1 端到端：起流 3 秒，验证真的收到画面帧。 */
const path = require('node:path');
const Module = require('node:module');

// 桩掉 vscode 模块（cast 只用到 log）
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') {
    return { window: { createOutputChannel: () => ({ appendLine() {}, show() {} }) } };
  }
  return origLoad.apply(this, arguments);
};

const { Screencast } = require(path.join(__dirname, '..', 'out', 'bridge', 'screencast.js'));

(async () => {
  let frames = 0;
  let bytes = 0;
  let firstMeta = null;
  const started = Date.now();

  let cast;
  try {
    cast = await Screencast.start({
      quality: 70,
      maxWidth: 1000,
      maxHeight: 700,
      everyNthFrame: 3,
      onFrame: (frame) => {
        frames += 1;
        bytes += frame.data.length;
        if (!firstMeta) {
          firstMeta = { width: frame.width, height: frame.height };
        }
      },
    });
  } catch (err) {
    console.log('[FAIL] 启动失败:', err.message);
    process.exit(1);
  }

  await new Promise((resolve) => setTimeout(resolve, 3000));
  const elapsed = (Date.now() - started) / 1000;
  await cast.stop('测试结束');

  const avgKb = frames ? bytes / frames / 1024 : 0;
  console.log(`收到 ${frames} 帧 / ${elapsed.toFixed(1)}s（${(frames / elapsed).toFixed(1)} fps）`);
  console.log(`平均 ${avgKb.toFixed(1)} KB/帧（base64）`);
  console.log(`画面尺寸: ${firstMeta ? firstMeta.width + '×' + firstMeta.height : '未知'}`);

  if (frames < 3) {
    console.log('[FAIL] 帧数太少，投送没有真正工作');
    process.exit(1);
  }
  if (!firstMeta || !firstMeta.width) {
    console.log('[FAIL] 元数据缺失');
    process.exit(1);
  }
  console.log('[PASS] M1 投送链路可用');
})();
