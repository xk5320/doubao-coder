/**
 * 从豆包桌面端的「技能 / 插件」面板读取真实清单。
 *
 * 只读：打开面板 → 读取 → 再点一次按钮关闭，不改变任何设置。
 */
import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';

export interface DesktopSkill {
  name: string;
  description: string;
  id?: string;
}

export interface DesktopSkillGroup {
  title: string;
  items: DesktopSkill[];
}

export interface DesktopSkillCatalog {
  /** 是否成功打开了技能面板并读到内容（0 项也算成功）。 */
  ok: boolean;
  groups: DesktopSkillGroup[];
  count: number;
}

export interface DesktopPlugin {
  name: string;
  description: string;
}

export interface DesktopPluginCatalog {
  /** 是否成功打开了插件面板并读到内容（0 个插件也算成功）。 */
  ok: boolean;
  plugins: DesktopPlugin[];
  actions: string[];
  count: number;
}

const SKILL_BUTTON = '[data-testid="general-agent-skill-button"]';
const PLUGIN_BUTTON = '[data-testid="general-agent-plugin-button"]';
const SKILL_PANEL_EXPR = "Boolean(document.querySelector('[data-testid=skill-panel-v2]'))";
const PLUGIN_PANEL_EXPR = "Boolean([...document.querySelectorAll('[data-input-engine-suggestion-panel=true]')].find((el) => (el.innerText || '').includes('添加插件') && (el.innerText || '').includes('管理插件')))";
const NL = 'String.fromCharCode(10)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureChatComposer(session: CdpSession): Promise<boolean> {
  const readyExpr = "Boolean(document.querySelector('[data-testid=chat_input_input]') && document.querySelector('[data-testid=general-agent-skill-button]') && document.querySelector('[data-testid=general-agent-plugin-button]'))";
  if (await session.evaluate<boolean>(readyExpr)) {
    return true;
  }
  await session
    .evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true")
    .catch(() => undefined);
  const waitReady = async (): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (await session.evaluate<boolean>(readyExpr)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  };
  const conversation = await session.evaluate<{ x: number; y: number } | undefined>(
    "(() => { const els = [...document.querySelectorAll('[data-testid=conversation-list-v2-item]')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); const el = els[0]; if (!el) return undefined; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
  );
  if (conversation) {
    await clickAt(session, conversation);
    if (await waitReady()) {
      return true;
    }
  }
  const point = await session.evaluate<{ x: number; y: number } | undefined>("(() => { const el = document.querySelector('[data-testid=create_conversation_button]'); if (!el) return undefined; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  if (!point) {
    return false;
  }
  await clickAt(session, point);
  return waitReady();
}

async function withPage<T>(port: number, fn: (session: CdpSession) => Promise<T>): Promise<T> {
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    throw new Error('没有找到豆包页面，请确认豆包已用调试端口启动。');
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  try {
    // 技能/插件面板在后台窗口里可能被节流，先置前再点。
    await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);
    await ensureChatComposer(session);
    return await fn(session);
  } finally {
    session.close();
  }
}

async function buttonPoint(session: CdpSession, selector: string): Promise<{ x: number; y: number } | undefined> {
  const selectorLiteral = JSON.stringify(selector);
  const script = "(() => { const els = [...document.querySelectorAll(" + selectorLiteral + ")]; for (const el of els) { const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue; const x = r.x + r.width / 2; const y = r.y + r.height / 2; const top = document.elementFromPoint(x, y); if (top && (top === el || el.contains(top))) return { x: x, y: y }; } return undefined; })()";
  return session.evaluate(script);
}

async function clickAt(session: CdpSession, point: { x: number; y: number }): Promise<void> {
  await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function clickButton(session: CdpSession, selector: string): Promise<boolean> {
  const point = await buttonPoint(session, selector);
  if (!point) {
    return false;
  }
  await clickAt(session, point);
  return true;
}

async function isOpen(session: CdpSession, expression: string): Promise<boolean> {
  return session.evaluate<boolean>(expression);
}

async function waitFor(session: CdpSession, expression: string, timeoutMs = 3500): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await isOpen(session, expression)) {
      return true;
    }
    await sleep(200);
  }
  return false;
}

/** 面板里的列表是分批渲染的；等数量连续两次不变再解析，避免只读到第一批。 */
async function waitForStableCount(session: CdpSession, expression: string, timeoutMs = 9000): Promise<number> {
  const started = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    await sleep(400);
    const count = await session.evaluate<number>(expression).catch(() => -1);
    if (count > 0 && count === last) {
      stable += 1;
      if (stable >= 2) {
        return count;
      }
    } else {
      stable = 0;
    }
    last = count;
  }
  return Math.max(0, last);
}

function skillParseScript(): string {
  return [
    '(async () => {',
    "  const panel = document.querySelector('[data-testid=skill-panel-v2]');",
    '  if (!panel) return [];',
    '  const groups = new Map();',
    '  const collect = () => {',
    "    for (const section of panel.querySelectorAll('section[data-skill-panel-group-id]')) {",
    "      const h = section.querySelector('h3');",
    "      const title = h ? (h.innerText || '').trim() : '';",
    '      if (!groups.has(title)) groups.set(title, { title: title, items: [] });',
    '      const group = groups.get(title);',
    "      for (const btn of section.querySelectorAll('button[data-skill-panel-action=item]')) {",
    "        const lines = (btn.innerText || '').split(" + NL + ").map((line) => line.trim()).filter(Boolean);",
    '        const name = lines[0] || "";',
    '        if (!name) continue;',
    "        if (name === '技能管理') continue;",
    "        if (group.items.some((item) => item.name === name)) continue;",
    "        group.items.push({ name: name, description: lines.slice(1).join(' '), id: btn.getAttribute('data-skill-panel-item-id') || '' });",
    '      }',
    '    }',
    '  };',
    '  collect();',
    '  const canScroll = (el) => el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);',
    '  const scroller = canScroll(panel) ? panel : [...panel.querySelectorAll("*")].find(canScroll);',
    '  if (scroller) {',
    '    for (let i = 0; i < 20; i += 1) {',
    '      scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(80, scroller.clientHeight * 0.8));',
    '      await new Promise((resolve) => setTimeout(resolve, 120));',
    '      collect();',
    '      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) break;',
    '    }',
    '    scroller.scrollTop = 0;',
    '  }',
    '  return [...groups.values()].filter((group) => group.items.length > 0);',
    '})()',
  ].join(String.fromCharCode(10));
}

function pluginParseScript(): string {
  return [
    '(() => {',
    "  const panels = [...document.querySelectorAll('[data-input-engine-suggestion-panel=true]')];",
    "  const panel = panels.find((el) => (el.innerText || '').includes('添加插件') && (el.innerText || '').includes('管理插件'));",
    "  if (!panel) return { plugins: [], actions: [] };",
    '  const options = [];',
    "  for (const row of panel.querySelectorAll('[role=option]')) {",
    "    const lines = (row.innerText || '').split(" + NL + ").map((line) => line.trim()).filter(Boolean);",
    '    const name = lines[0] || "";',
    '    if (!name) continue;',
    "    options.push({ name: name, description: lines.slice(1).join(' ') });",
    '  }',
    "  const actionSet = new Set(options.filter((item) => item.name === '添加插件' || item.name === '管理插件').map((item) => item.name));",
    "  for (const el of panel.querySelectorAll('button,[role=button]')) {",
    "    const text = (el.innerText || '').trim();",
    "    if (text === '添加插件' || text === '管理插件') actionSet.add(text);",
    '  }',
    "  const plugins = options.filter((item) => item.name !== '添加插件' && item.name !== '管理插件' && item.name !== '搜索...' && item.name !== '搜索');",
    '  return { plugins: plugins, actions: [...actionSet] };',
    '})()',
  ].join(String.fromCharCode(10));
}

/** 读取豆包桌面端的技能面板（常用 / 快捷功能 / 技能）。 */
export async function listDesktopSkills(port = DOUBAO_DEBUG_PORT): Promise<DesktopSkillCatalog> {
  return withPage(port, async (session) => {
    await waitFor(session, "Boolean(document.querySelector('[data-testid=general-agent-skill-button]'))", 3000);
    if (await isOpen(session, SKILL_PANEL_EXPR)) {
      await clickButton(session, SKILL_BUTTON);
      await sleep(300);
    }
    await clickButton(session, SKILL_BUTTON);
    let opened = await waitFor(session, SKILL_PANEL_EXPR, 2000);
    if (!opened) {
      await clickButton(session, SKILL_BUTTON);
      opened = await waitFor(session, SKILL_PANEL_EXPR, 1200);
    }

    // 固定等 2s 太慢：改成"解析到非空就返回"，最多 2.5s（通常 300–600ms）
    let groups: DesktopSkillGroup[] = [];
    if (opened) {
      for (let i = 0; i < 25; i += 1) {
        groups = await session.evaluate<DesktopSkillGroup[]>(skillParseScript());
        if (groups && groups.length > 0) {
          break;
        }
        await sleep(100);
      }
    }
    for (const group of groups) {
      group.title = group.title.replace(/\(\d+\)/, `(${group.items.length})`);
    }

    if (await isOpen(session, SKILL_PANEL_EXPR)) {
      await clickButton(session, SKILL_BUTTON);
      await sleep(200);
    }
    const count = groups.reduce((sum, group) => sum + group.items.length, 0);
    return { ok: opened, groups, count };
  });
}

/** 读取豆包桌面端的插件面板（已安装插件 + 添加/管理入口）。 */
export async function listDesktopPlugins(port = DOUBAO_DEBUG_PORT): Promise<DesktopPluginCatalog> {
  return withPage(port, async (session) => {
    if (await isOpen(session, PLUGIN_PANEL_EXPR)) {
      await clickButton(session, PLUGIN_BUTTON);
      await sleep(300);
    }
    if (await isOpen(session, SKILL_PANEL_EXPR)) {
      await clickButton(session, SKILL_BUTTON);
      await sleep(300);
    }
    await waitFor(session, "Boolean(document.querySelector('[data-testid=general-agent-plugin-button]'))", 3000);
    await clickButton(session, PLUGIN_BUTTON);
    let opened = await waitFor(session, PLUGIN_PANEL_EXPR, 3500);
    if (!opened) {
      await clickButton(session, PLUGIN_BUTTON);
      opened = await waitFor(session, PLUGIN_PANEL_EXPR, 1500);
    }

    if (opened) {
      await waitForStableCount(session, "(() => { const panels = [...document.querySelectorAll('[data-input-engine-suggestion-panel=true]')]; const panel = panels.find((el) => (el.innerText || '').includes('添加插件') && (el.innerText || '').includes('管理插件')); return panel ? panel.querySelectorAll('[role=option]').length : 0; })()");
    }
    const parsed = opened ? await session.evaluate<{ plugins: DesktopPlugin[]; actions: string[] }>(pluginParseScript()) : { plugins: [], actions: [] };

    if (await isOpen(session, PLUGIN_PANEL_EXPR)) {
      await clickButton(session, PLUGIN_BUTTON);
      await sleep(200);
    }
    return { ok: opened, plugins: parsed.plugins, actions: parsed.actions, count: parsed.plugins.length };
  });
}

async function ensureSkillPanel(session: CdpSession): Promise<boolean> {
  if (await isOpen(session, SKILL_PANEL_EXPR)) {
    return true;
  }
  if (await isOpen(session, PLUGIN_PANEL_EXPR)) {
    await clickButton(session, PLUGIN_BUTTON);
    await sleep(300);
  }
  await clickButton(session, SKILL_BUTTON);
  return waitFor(session, SKILL_PANEL_EXPR, 3500);
}

async function ensurePluginPanel(session: CdpSession): Promise<boolean> {
  if (await isOpen(session, PLUGIN_PANEL_EXPR)) {
    return true;
  }
  if (await isOpen(session, SKILL_PANEL_EXPR)) {
    await clickButton(session, SKILL_BUTTON);
    await sleep(300);
  }
  await clickButton(session, PLUGIN_BUTTON);
  return waitFor(session, PLUGIN_PANEL_EXPR, 3500);
}

/** 在豆包桌面端打开「添加插件 / 管理插件」并停留在前台。 */
export async function openDesktopPluginAction(
  port: number,
  action: '添加插件' | '管理插件',
): Promise<{ ok: boolean; error?: string }> {
  return withPage(port, async (session) => {
    if (!(await ensurePluginPanel(session))) {
      return { ok: false, error: '没有打开豆包插件面板' };
    }
    const point = await session.evaluate<{ x: number; y: number } | undefined>([
      '(() => {',
      "  const panels = [...document.querySelectorAll('[data-input-engine-suggestion-panel=true]')];",
      "  const panel = panels.find((el) => (el.innerText || '').includes('添加插件') && (el.innerText || '').includes('管理插件'));",
      '  if (!panel) return undefined;',
      "  for (const el of panel.querySelectorAll('[role=option],button,[role=button]')) {",
      "    if ((el.innerText || '').trim() !== " + JSON.stringify(action) + ') continue;',
      '    const r = el.getBoundingClientRect();',
      '    if (!r.width || !r.height) continue;',
      '    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };',
      '  }',
      '  return undefined;',
      '})()',
    ].join(String.fromCharCode(10)));
    if (!point) {
      return { ok: false, error: '插件面板里没有找到「' + action + '」' };
    }
    await clickAt(session, point);
    await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);
    await sleep(600);
    return { ok: true };
  });
}

/** 在豆包桌面端打开某个技能（例如「技能管理」）并停留在前台。 */
export async function openDesktopSkillAction(
  port: number,
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  return withPage(port, async (session) => {
    if (!(await ensureSkillPanel(session))) {
      return { ok: false, error: '没有打开豆包技能面板' };
    }
    const point = await session.evaluate<{ x: number; y: number } | undefined>([
      '(() => {',
      "  const panel = document.querySelector('[data-testid=skill-panel-v2]');",
      '  if (!panel) return undefined;',
      "  for (const el of panel.querySelectorAll('button[data-skill-panel-action=item]')) {",
      "    const first = ((el.innerText || '').split(" + NL + ")[0] || '').trim();",
      '    if (first !== ' + JSON.stringify(name) + ') continue;',
      '    const r = el.getBoundingClientRect();',
      '    if (!r.width || !r.height) continue;',
      '    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };',
      '  }',
      '  return undefined;',
      '})()',
    ].join(String.fromCharCode(10)));
    if (!point) {
      return { ok: false, error: '技能面板里没有找到「' + name + '」' };
    }
    await clickAt(session, point);
    await session.send('Page.bringToFront', {}, 3000).catch(() => undefined);
    await sleep(600);
    return { ok: true };
  });
}
