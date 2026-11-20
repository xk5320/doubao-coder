/** 桌面端连接问题的分类与提示（不依赖 vscode，便于单测）。 */

export type DesktopProblem =
  | 'ok'
  | 'not-installed'
  | 'port-closed'
  | 'port-not-cdp'
  | 'not-logged-in'
  | 'no-page';

export interface DesktopSignals {
  installed: boolean;
  portOpen: boolean;
  running: boolean;
  loggedIn: boolean;
  hasEditor: boolean;
}

export interface DesktopDiagnosis {
  code: DesktopProblem;
  title: string;
  hint: string;
}

export function classifyDesktop(signals: DesktopSignals): DesktopDiagnosis {
  if (!signals.installed) {
    return {
      code: 'not-installed',
      title: '没有安装豆包桌面版',
      hint: '先从官网安装豆包桌面版，安装后重启计算机，再点重新检测。',
    };
  }
  if (!signals.portOpen) {
    return {
      code: 'port-closed',
      title: '调试端口没有打开',
      hint: '请重启计算机后，用扩展的「以调试端口启动豆包」打开，并确认下面板日志。',
    };
  }
  if (!signals.running) {
    return {
      code: 'port-not-cdp',
      title: '端口已占用，但不是豆包调试端口',
      hint: '可能被其它程序占用；请关闭占用 9222 的程序，重启豆包后再检测。',
    };
  }
  if (!signals.loggedIn) {
    return {
      code: 'not-logged-in',
      title: '还没有登录豆包账号',
      hint: '在豆包窗口里登录账号并进入对话页，然后重新检测。',
    };
  }
  if (!signals.hasEditor) {
    return {
      code: 'no-page',
      title: '没有找到对话页面',
      hint: '打开任意豆包对话页（不是首页/设置页），再重新检测。',
    };
  }
  return { code: 'ok', title: '已就绪', hint: '豆包桌面端已就绪，可以免 Key 对话。' };
}
