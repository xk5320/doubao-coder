/**
 * 初始化时把豆包的「AI 生成水印」设置成「无水印」。
 *
 * 路径（实测 2.36.10）：
 *   设置 → 通用 → 内容生成与产物设置 → AI 生成水印管理 → 两行（文档/表格/PPT、图片/视频）
 *   点某一行 → 浮层「确认去除 AI 生成水印」+ 一个 role=switch 的开关（aria-checked=true 即无水印）
 *
 * 只在本机已登录的桌面端上点它自己的设置；不伪造任何接口。失败不抛给用户，只记日志。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from '../bridge/cdp';

const SEL = {
  settingsEntry: '[data-testid="sidebar_footer_setting_entry"]',
  categoryGeneral: '[data-testid="settings-category-general"]',
  creationOutput: '[data-testid="setup_creation_output"]',
  watermarkControl: '[data-testid="setup_watermark_control"]',
  modalClose: '[data-testid="setting-modal-close"]',
} as const;

const ROWS = ['生成的文档、表格、PPT', '生成的图片、视频'];

export interface WatermarkResult {
  ok: boolean;
  /** 本次实际从「有水印」改成「无水印」的项。 */
  changed: string[];
  /** 每一项目前的状态（true=无水印）。 */
  state: Array<{ label: string; noWatermark: boolean }>;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickPoint(session: CdpSession, point: { x: number; y: number }): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, buttons: 0 }, 3000);
  await session.send(
    'Input.dispatchMouseEvent',
    { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 },
    3000,
  );
  await session.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1 },
    3000,
  );
}

/** 找到元素 → 滚到中间 → 真实鼠标点击。找不到返回 false。 */
async function clickSelector(session: CdpSession, selector: string): Promise<boolean> {
  const point = await session.evaluate<{ x: number; y: number } | undefined>(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return undefined;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return undefined;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!point) {
    return false;
  }
  await clickPoint(session, point);
  return true;
}

/** 点击包含指定文案的 role=button（水印的两行）。 */
async function clickRowByText(session: CdpSession, label: string): Promise<boolean> {
  const point = await session.evaluate<{ x: number; y: number } | undefined>(
    `(() => {
      const wanted = ${JSON.stringify(label)};
      const rows = [...document.querySelectorAll('[role="button"]')].filter((el) => {
        const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
        return text.indexOf(wanted) >= 0 && text.length < wanted.length + 20;
      });
      const el = rows[0];
      if (!el) return undefined;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return undefined;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!point) {
    return false;
  }
  await clickPoint(session, point);
  return true;
}

async function waitFor(session: CdpSession, selector: string, timeoutMs = 6000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await session
      .evaluate<boolean>(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)
      .catch(() => false);
    if (ok) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/** 悬浮层里的开关（role=switch）是否已开（true=无水印）。 */
async function readSwitch(session: CdpSession): Promise<boolean | undefined> {
  return session
    .evaluate<boolean | undefined>(
      `(() => {
        const sw = [...document.querySelectorAll('button[role="switch"]')].find((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (!sw) return undefined;
        return sw.getAttribute('aria-checked') === 'true';
      })()`,
    )
    .catch(() => undefined);
}

async function toggleSwitch(session: CdpSession): Promise<boolean> {
  const point = await session.evaluate<{ x: number; y: number } | undefined>(
    `(() => {
      const sw = [...document.querySelectorAll('button[role="switch"]')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!sw) return undefined;
      const r = sw.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
  );
  if (!point) {
    return false;
  }
  await clickPoint(session, point);
  await sleep(300);
  return true;
}

/** 关闭浮层：点一下没有 role 的标题区域，避免误关整个设置。 */
async function dismissPopover(session: CdpSession): Promise<void> {
  const point = await session.evaluate<{ x: number; y: number } | undefined>(
    `(() => {
      const h = [...document.querySelectorAll('h1,h2,h3,div')].find((el) => {
        const t = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return t === 'AI 生成水印管理' && r.width > 100 && r.y < 260;
      });
      if (!h) return undefined;
      const r = h.getBoundingClientRect();
      return { x: r.x + 8, y: r.y + r.height / 2 };
    })()`,
  );
  if (point) {
    await clickPoint(session, point);
  }
  await sleep(250);
}

/** 主入口：确保两项都是「无水印」。 */
export async function applyNoWatermark(port = DOUBAO_DEBUG_PORT): Promise<WatermarkResult> {
  const result: WatermarkResult = { ok: false, changed: [], state: [] };
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    result.error = '没有找到豆包对话页';
    return result;
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);

    // 每次都从干净状态开始：上次可能停在某个子页面/浮层
    const alreadyOpen = await session
      .evaluate<boolean>('Boolean(document.querySelector(\'[data-testid="settings_modal"]\'))')
      .catch(() => false);
    if (alreadyOpen) {
      await clickSelector(session, SEL.modalClose).catch(() => undefined);
      await sleep(500);
    }
    if (!(await clickSelector(session, SEL.settingsEntry)) || !(await waitFor(session, '[data-testid="settings_modal"]'))) {
      result.error = '打不开设置面板';
      return result;
    }
    await sleep(600);
    if (!(await clickSelector(session, SEL.categoryGeneral))) {
      result.error = '没找到「通用」';
      return result;
    }
    await sleep(600);
    if (!(await waitFor(session, SEL.creationOutput, 5000)) || !(await clickSelector(session, SEL.creationOutput))) {
      result.error = '没找到「内容生成与产物设置」';
      return result;
    }
    await sleep(700);
    if (!(await waitFor(session, SEL.watermarkControl, 5000)) || !(await clickSelector(session, SEL.watermarkControl))) {
      result.error = '没找到「AI 生成水印管理」';
      return result;
    }
    await sleep(800);

    for (const label of ROWS) {
      const opened = await clickRowByText(session, label);
      if (!opened) {
        result.error = `点不开「${label}」`;
        return result;
      }
      await sleep(500);
      let checked = await readSwitch(session);
      if (checked === undefined) {
        result.error = `「${label}」没有找到开关`;
        return result;
      }
      if (!checked) {
        await toggleSwitch(session);
        await sleep(400);
        checked = await readSwitch(session);
        if (checked) {
          result.changed.push(label);
        }
      }
      result.state.push({ label, noWatermark: Boolean(checked) });
      await dismissPopover(session);
    }

    // 关闭设置，回到对话
    await clickSelector(session, SEL.modalClose).catch(() => undefined);
    result.ok = result.state.every((item) => item.noWatermark);
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  } finally {
    session.close();
  }
}
