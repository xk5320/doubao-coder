/** 面板绑定的对话被切走时，旁观必须停止，不能把别的任务结果写进当前会话。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const desktop = fs.readFileSync(path.join(root, 'src', 'bridge', 'desktop.ts'), 'utf8');
const panel = fs.readFileSync(path.join(root, 'src', 'chat', 'panel.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? ' → ' + detail : '')); }
}

check('旁观：支持期望标题', desktop.includes('expectTitle?: string'));
check('旁观：读当前对话标题', desktop.includes('editable_conversation_name'));
check('旁观：标题不一致就停止', desktop.includes('对话已切换，停止旁观'));
check('面板：旁观传当前任务标题', panel.includes('expectTitle: title'));
check('面板：记录绑定标题', panel.includes('setActiveTarget(desktopTarget(title'));
check('面板：回合后续跑用绑定标题', panel.includes("this.lastDesktopTitle || '当前任务'"));
check('发送前：读取当前对话标题', desktop.includes('export async function readDesktopTitle'));
check('发送前：标题不一致会切回目标对话', panel.includes('private async ensureDesktopConversation') && panel.includes('openDesktopConversation(hit.index, port, hit.id)'));
check('发送前：runDesktop/runTask 都校验', (panel.split('ensureDesktopConversation(this.lastDesktopTitle)').length - 1) >= 2);
check('无目标对话时提示可能发错', panel.includes('这条消息可能发错会话'));
check('历史对账：标记 desktopMissing', panel.includes('desktopMissing') && panel.includes('hasConversation'));
check('webview 显示「对话已不存在」', fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('对话已不存在'));
check('会话复用：同标题复用本地会话', panel.includes('existingSession') && panel.includes('normalizeTitle(title)'));
check('打开本地历史：绑定 desktopTitle', panel.includes('setActiveTarget(localTarget(record.id'));
check('打开本地历史：立即切回豆包对话', panel.includes('void this.ensureDesktopConversation(record.desktopTitle)'));
const chat = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8');
check('历史列表：点击带标题', chat.includes("type: 'openDesktopChat', index: item.index, title: item.title"));
check('打开历史：按标题重新定位', panel.includes('titleHint?: string') && panel.includes('realIndex = matched.item.index'));

check('恢复上次窗口：默认关闭', panel.includes('restoreLastWindow') && panel.includes('默认不自动抢占'));
const cfg = fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
check('配置：restoreLastWindow 默认 false', cfg.includes("restoreLastWindow: asBool(cfg.get<boolean>('restoreLastWindow'), false)"));
const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check('设置项：默认 false', pkgJson.contributes.configuration.properties['doubao.restoreLastWindow'].default === false);

check('后台任务：同步快照按激活目标过滤', panel.includes('pushSyncSnapshot') && (panel.includes('后台任务快照：写入对应会话') || panel.includes('忽略后台同步快照')));
check('后台任务：旁观推送按激活目标过滤', panel.includes('postIfActive') && panel.includes('忽略后台任务消息'));
check('切换激活目标：停止旧同步器', panel.includes("stop('激活目标切换')"));

check('两层对应：面板读取对话 id', panel.includes('readDesktopConversationId') && panel.includes('activeDesktopId'));
check('两层对应：打开时优先按 id', panel.includes('idHint') && panel.includes('fresh.items.find((item) => item.id === idHint)'));
check('两层对应：会话保存 desktopId', panel.includes('desktopId, turns') && panel.includes('desktopId: item.desktopId'));
check('两层对应：webview 传 id', fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('id: item.id'));

check('历史任务：完整收集器（展开更多+滚动）', fs.readFileSync(path.join(root, 'src', 'bridge', 'desktop-history-all.ts'), 'utf8').includes('展开更多'));
check('历史任务：按 id 打开并校验 active', panel.includes('openDesktopConversationById') && panel.includes('collectAllDesktopConversations'));
check('历史任务：加载进度带条数', panel.includes('正在同步豆包对话…（已 '));

check('标签：新建任务/对话立刻有标签', panel.includes("'新任务' : '新对话'") && panel.includes('this.ensureTab(this.sessionId)'));
check('标签：豆包回复后刷新名称', panel.includes('refreshTabTitleFromDesktop') && panel.includes('标签名已按豆包标题刷新'));
check('标签：回复结束调用刷新', panel.includes('void this.refreshTabTitleFromDesktop();'));

check('标签：首段回复就同步名称', panel.includes('tabTitleDirty') && panel.includes('void this.refreshTabTitleFromDesktop();'));
check('标签：豆包无标题时用首条消息兜底', panel.includes('用首条用户消息兜底'));

check('标签：切换后同步内容', panel.includes('refreshActiveTabContent') && panel.includes('正在同步任务内容…'));
check('标签：后台任务写入自己会话', panel.includes('storeBackgroundBlocks'));

check('切换对话：标题严格匹配（无子串）', panel.includes('Promise<boolean>') && !panel.includes('wanted.indexOf(current)') && !panel.includes('current.indexOf(wanted)'));
check('切换对话：切完校验 id/标题', panel.includes('切回目标对话后校验失败'));
check('标签同步：页面 id 不符不写入', panel.includes('跳过同步：页面不是目标任务'));

const extractor = fs.readFileSync(path.join(root, 'src', 'bridge', 'md-extractor.ts'), 'utf8');
check('子智能体：解析 complex-task 状态', extractor.includes('complex-task-block-wrapper') && extractor.includes('已委派子智能体执行'));

check('文件:行可点击：webview linkify', fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('linkifyFiles') && panel.includes("case 'openFile'"));
check('文件:行可点击：面板打开定位', panel.includes('openFileAt') && panel.includes('showTextDocument'));

check('审阅落盘：写文件先走 reviewEdit', fs.readFileSync(path.join(root, 'src', 'agent', 'tools.ts'), 'utf8').includes('reviewEdit'));
check('审阅落盘：面板请求审阅/接受', panel.includes('requestReview') && panel.includes('handleProposal') && panel.includes('proposalAction'));
check('审阅落盘：默认开启', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.configuration.properties['doubao.reviewEdits'].default === true);

const promptSrc = fs.readFileSync(path.join(root, 'src', 'chat', 'prompt.ts'), 'utf8');
check('上下文包：@目录 列出条目', promptSrc.includes('目录，') && promptSrc.includes('isDirectory'));
check('上下文包：git diff 读取模块', fs.existsSync(path.join(root, 'src', 'chat', 'git-context.ts')));
check('上下文包：审阅 Git 改动命令', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.commands.some(function (c) { return c.command === 'doubao.attachGitDiff'; }));

check('验证闭环：构建/测试模块', fs.existsSync(path.join(root, 'src', 'chat', 'verify.ts')));
check('验证闭环：面板运行与追问', panel.includes('runVerification') && panel.includes('askAboutVerification'));
check('验证闭环：界面按钮与卡片', panel.includes('data-verify') && fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('renderVerify'));

check('@ 文件选择器：面板列出工作区文件', panel.includes('sendWorkspaceFiles') && panel.includes('findFiles'));
check('@ 文件选择器：界面菜单与插入', fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('openFileMentionMenu'));

const sessionsSrc = fs.readFileSync(path.join(root, 'src', 'chat', 'sessions.ts'), 'utf8');
check('多项目隔离：会话按工作区作用域', sessionsSrc.includes('migrateFrom') && panel.includes('doubao.sessions:'));

check('审阅撤销：已接受改动可撤销', panel.includes('undoLastAccepted') && panel.includes('acceptedStack'));
check('审阅撤销：逐块接受', panel.includes('computeHunks') && panel.includes('applyHunks'));
check('审阅撤销：命令已注册', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.commands.some(function (c) { return c.command === 'doubao.undoAcceptedEdit'; }));

check('验证闭环：失败项可定位', panel.includes('parseVerifyLocations') && fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('verify-location'));

check('闭环：接受改动后自动验证', panel.includes('autoVerifyAfterAccept') && panel.includes('自动构建验证'));
check('闭环：上下文 token 估算', panel.includes('postContextInfo') && panel.includes("type: 'contextInfo'"));
check('闭环：自动验证可配置', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.configuration.properties['doubao.verify.afterAccept'].default === true);

check('连接问题分类：独立模块', fs.existsSync(path.join(root, 'src', 'bridge', 'desktop-errors.ts')));
check('连接问题分类：setup 使用分类', fs.readFileSync(path.join(root, 'src', 'doubao', 'setup.ts'), 'utf8').includes('classifyDesktop'));
check('多根工作区：scope 覆盖所有根目录', panel.includes('folders.join'));

check('任务中心：后台任务状态推送', panel.includes('postTasks') && panel.includes('startBackgroundTask'));
check('来源面板：收集文件引用', panel.includes('postSources') && fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('renderSources'));

check('发布：CI workflow 存在', fs.existsSync(path.join(root, '..', '..', '.github', 'workflows', 'ci.yml')));
check('发布：Release workflow 存在', fs.existsSync(path.join(root, '..', '..', '.github', 'workflows', 'release.yml')));
check('MCP 模板：命令已注册', JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).contributes.commands.some(function (c) { return c.command === 'doubao.addMcpTemplate'; }));

check('CLI 登录引导：自动打开登录并重试', panel.includes('handleCliLoginRequired') && panel.includes('登录成功，正在自动重试'));
check('CLI 登录引导：识别 login_required', panel.includes('login_required'));

check('CLI 登录：二维码渲染到对话', panel.includes('showCliLoginQr') && panel.includes("type: 'image'") && panel.includes('startCliLogin'));
check('CLI 登录：conflict 自动重试', panel.includes('正在切换账号'));

check('CLI 引导：对话内安装→登录流程', panel.includes('startCliOnboarding') && panel.includes('runCliInstallInChat') && panel.includes('postCliGuide'));
check('CLI 引导：按钮动作分发', panel.includes('handleCliGuideAction') && panel.includes("case 'cliGuideAction'"));
check('CLI 引导：webview 渲染卡片', fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8').includes('renderCliGuide'));

const extSrc = fs.readFileSync(path.join(root, 'src', 'extension.ts'), 'utf8');
check('优先级：桌面版排在 CLI 前面', extSrc.indexOf('豆包桌面版（推荐') > 0 && extSrc.indexOf('豆包桌面版（推荐') < extSrc.indexOf('豆包 CLI（可选'));
check('优先级：可一键切回桌面版', extSrc.includes('doubao.useDesktopMode'));
check('CLI 静默超时提示', panel.includes('sawCliOutput') && panel.includes('一分钟没有任何输出'));
check('设置中心顺序：桌面版优先', fs.readFileSync(path.join(root, 'media', 'settings.js'), 'utf8').includes("['desktop', 'cli', 'ark']"));

check('新对话：清除激活目标', panel.includes("this.setActiveTarget(noneTarget())") && panel.includes('新对话不再绑定上一个任务'));
check('新对话：流式内容按会话隔离', panel.includes('streamOwner') && panel.includes('STREAM_TYPES'));
check('新对话：停止旧同步器', panel.includes("syncPoller?.stop('用户停止或切换会话')"));
check('同步快照：只渲染发起会话', panel.includes('只在「发起同步的那个会话」里渲染'));

check('新对话：回合令牌防止旧任务改状态', panel.includes('private runToken = 0;') && panel.includes('private beginRun(') && panel.includes('private endRun('));
check('新对话：中止时作废令牌', panel.includes('作废当前回合令牌'));
check('新对话：5 处回合走 beginRun', (panel.match(/const runToken = this\.beginRun\(\)/g) || []).length === 5, String((panel.match(/const runToken = this\.beginRun\(\)/g) || []).length));

const chatJs = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8');
check('历史重命名：行内输入框', chatJs.includes('history-rename-input') && chatJs.includes("type: 'sessionRename'"));
check('历史重命名：回车/ESC 处理', chatJs.includes("event.key === 'Enter'") && chatJs.includes("event.key === 'Escape'"));
check('历史重命名：改走行内输入而非弹窗', chatJs.includes('function startInlineRename(') && chatJs.indexOf("action: 'rename'") < 0);
check('历史重命名：后端内联改名', panel.includes('renameSessionInline') && panel.includes("case 'sessionRename'"));
check('历史重命名：不触发豆包重新同步', panel.includes('localOnly') && panel.includes('沿用上次抓到的豆包列表'));

console.log('\n结果：PASS ' + pass + '，FAIL ' + fail);
process.exit(fail ? 1 : 0);