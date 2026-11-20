/**
 * 公开动作面移植（对照 `computer_use/_windows/public/api.py` 的 20 个函数）
 *
 * 语义与**校验怪癖**都保持与原实现一致，几处容易"顺手改错"的点：
 *   1. `coordinate()` 只校验"有限数字"，**并不夹到 [0,1000]**（`_validation.py:33-49`）
 *   2. `scroll(delta=…)` 接受数字 ±1..10（四舍五入）或 up/down/left/right（±5，left/right 置横向）
 *   3. `hotkey(*keys)` 必须逐键传；某键含 `+` → CU_BAD_HOTKEY；空 → 直接返回
 *   4. `type("")` 直接返回，不发任何动作
 *   5. `wait()` 是**纯本地 sleep**，不产生动作记录
 *   6. `switch_desktop` 只接受 main / pip
 *   7. 坐标是 **0–1000 归一化**，由后端换算成屏幕像素
 */
import type { CuBackend } from './backend';
import { CellExecutor } from './cell';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class CuError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CuError';
  }
}

const invalid = (message: string): never => {
  throw new CuError('CU_INVALID_ACTION', message);
};

/** 归一化坐标校验：只查"有限数字"（故意不 clamp，与原实现一致）。 */
export function coordinate(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(`${name} must be a finite number (normalized coordinates in [0,1000])`);
  }
  return value;
}

/** 滚轮 delta：数字 ±1..10，或 up/down/left/right（±5）。 */
export function scrollDelta(delta: unknown): { value: number; horizontal: boolean } {
  if (typeof delta === 'string') {
    const key = delta.trim().toLowerCase();
    if (key === 'up' || key === 'down') {
      return { value: key === 'up' ? 5 : -5, horizontal: false };
    }
    if (key === 'left' || key === 'right') {
      return { value: key === 'left' ? -5 : 5, horizontal: true };
    }
    throw new CuError('CU_SCROLL_DELTA', `delta 只能是数字或 up/down/left/right，收到 ${delta}`);
  }
  if (typeof delta !== 'number' || !Number.isFinite(delta)) {
    throw new CuError('CU_SCROLL_DELTA', 'delta 必须是数字');
  }
  const magnitude = Math.min(10, Math.max(1, Math.round(Math.abs(delta))));
  return { value: delta < 0 ? -magnitude : magnitude, horizontal: false };
}

/** wait 秒数：默认 3，范围 [0,180]。 */
export function waitSeconds(seconds: unknown): number {
  if (seconds === undefined || seconds === null) {
    return 3;
  }
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    throw new CuError('CU_WAIT_SECONDS', 'seconds 必须是数字');
  }
  if (seconds < 0 || seconds > 180) {
    throw new CuError('CU_WAIT_SECONDS', 'seconds 必须在 [0,180] 之间');
  }
  return seconds;
}

/** 键名归一：小写 + 4 个别名（`_validation.py:8-13`）。 */
const KEY_ALIASES: Record<string, string> = {
  control: 'ctrl',
  escape: 'esc',
  return: 'enter',
  del: 'delete',
};
export function normalizeKey(key: unknown): string {
  if (typeof key !== 'string') {
    return invalid('key 必须是字符串');
  }
  const lower = key.trim().toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export interface CuApiOptions {
  backend: CuBackend;
  cell?: CellExecutor;
  /** 截图落盘目录（默认系统临时目录）。 */
  imageDir?: string;
  /** 是否把截图作为观察写入 cell（对应 show=True）。 */
  show?: boolean;
}

/** 20 个动作的对外实现。 */
export class ComputerUse {
  private readonly cell: CellExecutor;
  private readonly backend: CuBackend;
  private readonly imageDir: string;

  constructor(options: CuApiOptions) {
    this.backend = options.backend;
    this.cell = options.cell ?? new CellExecutor();
    this.imageDir = options.imageDir ?? tmpdir();
  }

  public get executor(): CellExecutor {
    return this.cell;
  }

  private async run<T>(op: string, args: unknown[], fn: () => Promise<T>, after?: (result: T) => Promise<void>): Promise<T> {
    const action = this.cell.record('cu', op, args);
    try {
      const result = await fn();
      this.cell.settle(action, true);
      if (after) {
        await after(result);
      }
      return result;
    } catch (err) {
      this.cell.settle(action, false);
      throw err;
    }
  }

  /* ---------- 屏幕 ---------- */

  public async screenshot(tag?: string, show = true): Promise<{ path: string; width: number; height: number }> {
    const shot = await this.run('screenshot', [tag ?? null], () => this.backend.screenshot());
    const file = join(this.imageDir, `cu-${Date.now()}.png`);
    await writeFile(file, shot.png);
    if (show) {
      this.cell.addImage(file, shot.width, shot.height, tag);
    }
    return { path: file, width: shot.width, height: shot.height };
  }

  public async switchDesktop(desktop: string): Promise<void> {
    if (desktop !== 'main' && desktop !== 'pip') {
      return invalid(`desktop 只能是 main 或 pip，收到 ${desktop}`);
    }
    await this.run('switch_desktop', [desktop], () => this.backend.switchDesktop(desktop));
  }

  /* ---------- 应用 ---------- */

  public async listApps(): Promise<Array<{ name: string }>> {
    return this.backend.listApps();
  }

  public async launchApp(name: string): Promise<Record<string, unknown>> {
    if (typeof name !== 'string') {
      return invalid('name 必须是字符串');
    }
    return this.run('launch_app', [name], () => this.backend.launchApp(name));
  }

  /* ---------- 鼠标 ---------- */

  public async click(x: number, y: number): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    await this.run('click', [nx, ny], () => this.backend.click(nx, ny, 1, 'left'));
  }

  public async leftDouble(x: number, y: number): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    await this.run('left_double', [nx, ny], () => this.backend.click(nx, ny, 2, 'left'));
  }

  public async tripleClick(x: number, y: number): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    await this.run('triple_click', [nx, ny], () => this.backend.click(nx, ny, 3, 'left'));
  }

  public async rightSingle(x: number, y: number): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    await this.run('right_single', [nx, ny], () => this.backend.click(nx, ny, 1, 'right'));
  }

  public async hover(x: number, y: number): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    await this.run('hover', [nx, ny], () => this.backend.hover(nx, ny));
  }

  public async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const [a, b, c, d] = [coordinate('x1', x1), coordinate('y1', y1), coordinate('x2', x2), coordinate('y2', y2)];
    await this.run('drag', [a, b, c, d], () => this.backend.drag(a, b, c, d));
  }

  public async scroll(x: number, y: number, delta: unknown): Promise<void> {
    const [nx, ny] = [coordinate('x', x), coordinate('y', y)];
    const { value, horizontal } = scrollDelta(delta);
    await this.run('scroll', [nx, ny, value], () => this.backend.scroll(nx, ny, value, horizontal));
  }

  /* ---------- 键盘 ---------- */

  public async type(text: string | null | undefined): Promise<void> {
    const value = text ?? '';
    if (value.length === 0) {
      return; // 空串直接返回，不发动作
    }
    await this.run('type', [value], () => this.backend.typeText(value));
  }

  public async hotkey(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const normalized = keys.map((k) => {
      if (typeof k !== 'string') {
        return invalid('hotkey 的每个键都必须是字符串');
      }
      if (k.includes('+')) {
        throw new CuError('CU_BAD_HOTKEY', `hotkey 必须逐键传，不要写 "ctrl+c"，收到 ${k}`);
      }
      return normalizeKey(k);
    });
    await this.run('hotkey', normalized, () => this.backend.hotkey(normalized));
  }

  public async press(key: string): Promise<void> {
    const k = normalizeKey(key);
    await this.run('press', [k], () => this.backend.press(k));
  }

  public async keyDown(key: string): Promise<void> {
    const k = normalizeKey(key);
    await this.run('key_down', [k], () => this.backend.keyDown(k));
  }

  public async keyUp(key: string): Promise<void> {
    const k = normalizeKey(key);
    await this.run('key_up', [k], () => this.backend.keyUp(k));
  }

  /* ---------- 剪贴板 / 等待 ---------- */

  public async getClipboard(): Promise<string> {
    return this.backend.clipboardGet();
  }

  public async setClipboard(text: string | null | undefined): Promise<void> {
    await this.backend.clipboardSet(text ?? '');
  }

  public async copySelection(): Promise<string> {
    await this.hotkey('ctrl', 'c');
    await new Promise((r) => setTimeout(r, 120));
    return this.backend.clipboardGet();
  }

  /** 纯本地 sleep，不记录动作（与原实现一致）。 */
  public async wait(seconds?: number): Promise<void> {
    const s = waitSeconds(seconds);
    await new Promise((r) => setTimeout(r, Math.round(s * 1000)));
  }
}
