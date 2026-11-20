/**
 * 豆包桌面端「开箱检查」：安装 → 登录 → 以调试端口启动。
 *
 * 判断逻辑刻意保守：任何一步没确认都算「没就绪」，界面上给引导按钮，
 * 而不是让用户直接收到一句「连接 9222 失败」。
 */
import { detectInstall, type DoubaoInstall } from './install';
import { isPortOpen, probeDesktop, type DesktopStatus } from '../bridge/desktop';
import { classifyDesktop } from '../bridge/desktop-errors';

export type SetupStep = 'install' | 'login' | 'launch' | 'ready';

export interface SetupState {
  /** 已安装（找到 Doubao.exe）。 */
  installed: boolean;
  install?: Pick<DoubaoInstall, 'exePath' | 'root' | 'version'>;
  /** 调试端口连上了（说明客户端在跑且带 --remote-debugging-port）。 */
  running: boolean;
  /** 已登录（页面里能找到消息列表/输入框，且没有登录引导）。 */
  loggedIn: boolean;
  /** 完全就绪，可以免 Key 使用。 */
  ready: boolean;
  /** 当前该做的那一步。 */
  step: SetupStep;
  /** 给用户看的一句话说明（含失败原因）。 */
  detail: string;
  /** 问题分类码（ok / not-installed / port-closed / port-not-cdp / not-logged-in / no-page）。 */
  code?: string;
  /** 修复建议。 */
  hint?: string;
  checkedAt: number;
}

function pick(install: DoubaoInstall): SetupState['install'] {
  return {
    exePath: install.exePath,
    root: install.root,
    version: (install as unknown as { version?: string }).version,
  };
}

/** 综合检测当前机器是否可以直接用「桌面端免 Key」。 */
export async function checkEnvironment(port: number): Promise<SetupState> {
  const checkedAt = Date.now();
  let install: DoubaoInstall | undefined;
  try {
    install = await detectInstall();
  } catch {
    install = undefined;
  }

  if (!install) {
    return {
      installed: false,
      running: false,
      loggedIn: false,
      ready: false,
      step: 'install',
      detail: '没有找到豆包桌面端，请先安装后再回来检测。',
      checkedAt,
    };
  }

  const portOpen = await isPortOpen(port).catch(() => false);
  let status: DesktopStatus;
  try {
    status = await probeDesktop(port);
  } catch (err) {
    status = {
      ok: false,
      port,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const running = Boolean(status.browser) || Boolean(status.targets?.length);
  const loggedIn = Boolean(status.loggedIn && status.hasEditor);
  const diagnosis = classifyDesktop({
    installed: true,
    portOpen: portOpen || running,
    running,
    loggedIn,
    hasEditor: Boolean(status.hasEditor),
  });

  if (!running) {
    return {
      installed: true,
      install: pick(install),
      running: false,
      loggedIn: false,
      ready: false,
      step: 'launch',
      detail: diagnosis.title + '：' + diagnosis.hint,
      code: diagnosis.code,
      hint: diagnosis.hint,
      checkedAt,
    };
  }

  if (!loggedIn) {
    return {
      installed: true,
      install: pick(install),
      running: true,
      loggedIn: false,
      ready: false,
      step: 'login',
      detail: diagnosis.title + '：' + diagnosis.hint,
      code: diagnosis.code,
      hint: diagnosis.hint,
      checkedAt,
    };
  }

  return {
    installed: true,
    install: pick(install),
    running: true,
    loggedIn: true,
    ready: true,
    step: 'ready',
    detail: '豆包桌面端已就绪，可以直接免 Key 对话。',
    code: 'ok',
    hint: '可以开始对话了。',
    checkedAt,
  };
}
