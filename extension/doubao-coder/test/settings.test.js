/**
 * 设置中心离线单测：配置白名单 / 归一化 / 清单接线 / 前端产物。
 * 用法：node test/settings.test.js
 */
const fs = require('node:fs');
const path = require('node:path');

const pkg = require(path.join(__dirname, '..', 'package.json'));
const {
  isAuthMode,
  isSettingsKey,
  normalizeSettingValue,
  SETTINGS_KEYS,
} = require(path.join(__dirname, '..', 'out', 'settings', 'schema.js'));

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

/* ---- 白名单 ---- */
check('白名单：包含 CLI 权限', SETTINGS_KEYS.includes('cli.permissionMode'));
check('白名单：包含通用开关', SETTINGS_KEYS.includes('terminal.autoRun'));
check('未知 key 拒绝', !isSettingsKey('apiKey'));
check('authMode 只接受三种', isAuthMode('cli') && isAuthMode('desktop') && isAuthMode('ark') && !isAuthMode('none'));

/* ---- 归一化 ---- */
check('枚举：合法值通过', normalizeSettingValue('cli.permissionMode', 'always_allow').value === 'always_allow');
check('枚举：非法值拒绝', normalizeSettingValue('cli.permissionMode', 'yolo').ok === false);
check('数字：字符串数字转 number', normalizeSettingValue('cli.timeoutMs', '120000').value === 120000);
check('数字：越界拒绝', normalizeSettingValue('cli.timeoutMs', 1000).ok === false);
check('数字：端口越界拒绝', normalizeSettingValue('desktop.port', 70000).ok === false);
check('数字：倒计时越界拒绝', normalizeSettingValue('autoContinueSeconds', 121).ok === false);
check('布尔：只接受布尔', normalizeSettingValue('reviewEdits', 'true').ok === false);
check('布尔：true 通过', normalizeSettingValue('reviewEdits', true).value === true);
check('字符串：去首尾空格', normalizeSettingValue('cli.model', '  doubao-seed-code  ').value === 'doubao-seed-code');
check('字符串：过长拒绝', normalizeSettingValue('cli.path', 'x'.repeat(2000)).ok === false);
check('未知 key 返回错误', normalizeSettingValue('apiKey', 'sk-xxx').ok === false);

/* ---- 清单 ---- */
const commands = pkg.contributes.commands.map((item) => item.command);
check('清单：设置中心命令已声明', commands.includes('doubao.openSettingsPanel'));
const menus = (pkg.contributes.menus['view/title'] || []).map((item) => item.command);
check('清单：侧边栏标题按钮', menus.includes('doubao.openSettingsPanel'));
check('清单：激活事件包含设置中心', pkg.activationEvents.includes('onCommand:doubao.openSettingsPanel'));
check('清单：自动安装命令', commands.includes('doubao.cliAutoInstall') && pkg.activationEvents.includes('onCommand:doubao.cliAutoInstall'));
check('清单：版本 >= 0.51.0', String(pkg.version) >= '0.51.0');

/* ---- 产物 ---- */
const root = path.join(__dirname, '..');
check('样式文件存在', fs.existsSync(path.join(root, 'media', 'settings.css')));
check('前端脚本存在', fs.existsSync(path.join(root, 'media', 'settings.js')));
const js = fs.readFileSync(path.join(root, 'media', 'settings.js'), 'utf8');
check('前端：连接方式切换', js.includes("type: 'setMode'"));
check('前端：配置更新', js.includes("type: 'update'"));
check('前端：动作按钮', js.includes("type: 'action'"));
check('前端：登录/检查按钮', js.includes("'cliLogin'") && js.includes("'cliCheck'"));
const backend = fs.readFileSync(path.join(root, 'out', 'settings', 'panel.js'), 'utf8');
check('后端：注册命令处理', backend.includes("'setMode'") && backend.includes('normalizeSettingValue'));
check('后端：CLI 登录动作', backend.includes("'cliLogin'"));
check('后端：一键自动安装动作', backend.includes('cliAutoInstall') && backend.includes('runNpmInstall'));
check('后端：切到 CLI 时提示安装', backend.includes('是否现在自动安装'));
check('前端：未安装引导卡片', js.includes('还没安装豆包 CLI') && js.includes('cliAutoInstall'));
check('安装器产物存在', fs.existsSync(path.join(root, 'out', 'cli', 'install.js')));
check('前端：安装进度消息', js.includes("'installProgress'") && js.includes("'installDone'"));
const extensionJs = fs.readFileSync(path.join(root, 'out', 'extension.js'), 'utf8');
check('扩展：注册设置中心命令', extensionJs.includes('doubao.openSettingsPanel'));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  process.exitCode = 1;
}
