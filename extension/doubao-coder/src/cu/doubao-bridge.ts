/**
 * 「直接用豆包安装目录里的 SDK」后端
 *
 * 把动作转发给 `task-mode-resource/python-packages` 里的官方 `seed_computer_use`：
 *   python -c "import seed_computer_use as cu; cu.click(500,300)"
 *
 * 前提：进程里有 GAC 通道（CUA_GAC_SERVER_PORT/SECRET 等），
 * 也就是**由豆包拉起的环境**。否则会抛 `GUI as Coding is not available`，
 * 由 backend-select 捕获并退化到本地 Win32 后端（并告知原因）。
 */
import { spawn } from 'node:child_process';
import type { CuBackend } from './backend';
import type { DoubaoInstall } from '../doubao/install';

function runPython(pythonPath: string, code: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(pythonPath, ['-c', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Python 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      err += c.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code2) => {
      clearTimeout(timer);
      if (code2 === 0) {
        resolve(out);
      } else {
        reject(new Error(err.trim().split(/\r?\n/).pop() || `Python 退出码 ${code2}`));
      }
    });
  });
}

export class DoubaoSdkBackend implements CuBackend {
  constructor(
    private readonly install: DoubaoInstall,
    private readonly pythonPath = 'python',
    private readonly timeoutMs = 60_000,
  ) {}

  private async call(body: string): Promise<string> {
    const script = [
      'import sys, json',
      `sys.path.insert(0, r"${this.install.pythonPackagesDir}")`,
      'import seed_computer_use as cu',
      'try:',
      ...body.split('\n').map((line) => `    ${line}`),
      'except Exception as e:',
      '    print(json.dumps({"__error": "%s: %s" % (type(e).__name__, e)}, ensure_ascii=False))',
      '    raise SystemExit(0)',
    ].join('\n');
    const out = await runPython(this.pythonPath, script, this.timeoutMs);
    const last = out.trim().split(/\r?\n/).pop() ?? '{}';
    const parsed = JSON.parse(last) as Record<string, unknown>;
    if (typeof parsed.__error === 'string') {
      throw new Error(parsed.__error);
    }
    return last;
  }

  public async screenshot(): Promise<{ width: number; height: number; png: Buffer }> {
    const raw = await this.call(
      [
        'f = cu.screenshot(show=False)',
        'import base64',
        'print(json.dumps({"w": f.width, "h": f.height, "b64": base64.b64encode(bytes(f)).decode()}))',
      ].join('\n'),
    );
    const parsed = JSON.parse(raw) as { w: number; h: number; b64: string };
    return { width: parsed.w, height: parsed.h, png: Buffer.from(parsed.b64, 'base64') };
  }

  public async listApps(): Promise<Array<{ name: string }>> {
    const raw = await this.call('apps = cu.list_apps()\nprint(json.dumps({"apps": [{"name": a["name"]} for a in apps]}))');
    return (JSON.parse(raw) as { apps: Array<{ name: string }> }).apps;
  }

  public async launchApp(name: string): Promise<Record<string, unknown>> {
    const raw = await this.call(`r = cu.launch_app(${JSON.stringify(name)})\nprint(json.dumps({"r": r}))`);
    return (JSON.parse(raw) as { r: Record<string, unknown> }).r;
  }

  public async click(x: number, y: number, clicks: number, button: 'left' | 'right'): Promise<void> {
    const fn = button === 'right' ? 'right_single' : clicks >= 3 ? 'triple_click' : clicks === 2 ? 'left_double' : 'click';
    await this.call(`cu.${fn}(${x}, ${y})\nprint(json.dumps({"ok": True}))`);
  }

  public async hover(x: number, y: number): Promise<void> {
    await this.call(`cu.hover(${x}, ${y})\nprint(json.dumps({"ok": True}))`);
  }

  public async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await this.call(`cu.drag(${x1}, ${y1}, ${x2}, ${y2})\nprint(json.dumps({"ok": True}))`);
  }

  public async scroll(x: number, y: number, delta: number, horizontal: boolean): Promise<void> {
    const arg = horizontal ? (delta < 0 ? "'left'" : "'right'") : String(delta);
    await this.call(`cu.scroll(${x}, ${y}, ${arg})\nprint(json.dumps({"ok": True}))`);
  }

  public async typeText(text: string): Promise<void> {
    await this.call(`cu.type(${JSON.stringify(text)})\nprint(json.dumps({"ok": True}))`);
  }

  public async hotkey(keys: string[]): Promise<void> {
    const args = keys.map((k) => JSON.stringify(k)).join(', ');
    await this.call(`cu.hotkey(${args})\nprint(json.dumps({"ok": True}))`);
  }

  public async press(key: string): Promise<void> {
    await this.call(`cu.press(${JSON.stringify(key)})\nprint(json.dumps({"ok": True}))`);
  }

  public async keyDown(key: string): Promise<void> {
    await this.call(`cu.key_down(${JSON.stringify(key)})\nprint(json.dumps({"ok": True}))`);
  }

  public async keyUp(key: string): Promise<void> {
    await this.call(`cu.key_up(${JSON.stringify(key)})\nprint(json.dumps({"ok": True}))`);
  }

  public async clipboardGet(): Promise<string> {
    const raw = await this.call('t = cu.get_clipboard()\nprint(json.dumps({"t": t}))');
    return String((JSON.parse(raw) as { t: string }).t ?? '');
  }

  public async clipboardSet(text: string): Promise<void> {
    await this.call(`cu.set_clipboard(${JSON.stringify(text)})\nprint(json.dumps({"ok": True}))`);
  }

  public async switchDesktop(desktop: 'main' | 'pip'): Promise<void> {
    await this.call(`cu.switch_desktop(${JSON.stringify(desktop)})\nprint(json.dumps({"ok": True}))`);
  }
}
