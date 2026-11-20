/** 历史里打开“正在执行”的任务：必须进入旁观并持续同步状态。 */
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

const fnStart = panel.indexOf('private async openDesktopChat');
const fnEnd = panel.indexOf('  private drainQueuedUser');
const body = fnStart >= 0 && fnEnd > fnStart ? panel.slice(fnStart, fnEnd) : '';
check('找到 openDesktopChat', body.length > 0);
check('先判断是否仍在执行（早于内容判空）', body.indexOf('const stillRunning = await isDesktopRunning') >= 0 && body.indexOf('const stillRunning') < body.lastIndexOf('if (!content.ok'), 'order');
check('内容读不到时也会进入同步', body.indexOf('任务仍在执行，正在同步进度') >= 0 && body.indexOf('this.resumeRunningHistory(title)') >= 0);
check('已经有任务在跑时不重复旁观', panel.indexOf('private resumeRunningHistory') >= 0 && panel.indexOf('if (this.running || this.disposed)') >= 0);
check('旁观上限 30 分钟', panel.includes('timeoutMs: 30 * 60_000'));
check('旁观持续推送分块与状态', panel.indexOf('onBlocks:') >= 0 && panel.indexOf('onProgress:') >= 0);
check('正在执行：自动排队「继续说」', panel.indexOf('resumeRunningHistory') >= 0 && panel.indexOf("this.queuedUser.push({ text: '继续说', refs: {} })") >= 0);
check('结束后自动续发，并抑制 webview 重复', panel.indexOf('autoSuppress: suppress') >= 0 && panel.indexOf('this.drainQueuedUser()') >= 0);
check('保存上次打开的窗口', panel.indexOf("globalState.update('doubao.lastDesktop'") >= 0);
check('打开面板时恢复上次窗口', panel.indexOf('void this.restoreLastDesktop()') >= 0 && panel.indexOf("'doubao.lastDesktop'") >= 0 && panel.indexOf('shouldRestoreLastWindow') >= 0);
check('恢复时按标题匹配并打开', panel.indexOf('list.items.find((item) => item.title === title)') >= 0 && panel.indexOf('await this.openDesktopChat(hit.index)') >= 0);

check('回合结束但仍在执行：自动续「继续说」', panel.indexOf("this.resumeRunningHistory(this.lastDesktopTitle || '当前任务')") >= 0 && panel.indexOf('回合结束但豆包仍在执行，自动续') >= 0);
check('自动续跑有上限，防止无限循环', panel.indexOf('autoResumeCount >= 20') >= 0);
check('用户发话重置续跑计数', panel.indexOf('this.autoResumeCount = 0') >= 0);

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);