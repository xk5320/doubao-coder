/**
 * 豆包桌面端「开箱检查」：安装 → 登录 → 以调试端口启动。
 *
 * 判断逻辑刻意保守：任何一步没确认都算「没就绪」，界面上给引导按钮，
 * 而不是让用户直接收到一句「连接 9222 失败」。
 */
import { detectInstall, type DoubaoInstall } from './install';
import { probeDesktop, type DesktopStatus } from '../bridge/desktop';

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

  if (!running) {
    return {
      installed: true,
      install: pick(install),
      running: false,
      loggedIn: false,
      ready: false,
      step: 'launch',
      detail: '检测到已安装，但调试端口没通：请先完全退出豆包，再点「以调试端口启动」。',
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
      detail: '豆包已在调试端口上，但页面停在登录/首页：请在豆包窗口里登录账号并进入对话页。',
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
    checkedAt,
  };
}
