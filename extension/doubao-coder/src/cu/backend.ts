/**
 * 后端接口 + Windows 实现
 *
 * 原实现的后端是"宿主进程 + GAC 管道"（我们无法复用它，因为需要宿主 secret）。
 * 这里用 **PowerShell + Win32 SendInput** 做等价实现：
 *   - 截图：System.Drawing 抓**整个虚拟桌面**（多屏合并），与原实现一致
 *   - 鼠标/键盘：SendInput（含 KEYEVENTF_UNICODE，支持中文）
 *   - 剪贴板/应用列表：PowerShell 原生 cmdlet
 *
 * 坐标约定：对外一律 0–1000 归一化，在这里换算成像素。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CuError } from './actions';

const execFileAsync = promisify(execFile);

export interface CuBackend {
  screenshot(): Promise<{ width: number; height: number; png: Buffer }>;
  listApps(): Promise<Array<{ name: string }>>;
  launchApp(name: string): Promise<Record<string, unknown>>;
  click(x: number, y: number, clicks: number, button: 'left' | 'right'): Promise<void>;
  hover(x: number, y: number): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number): Promise<void>;
  scroll(x: number, y: number, delta: number, horizontal: boolean): Promise<void>;
  typeText(text: string): Promise<void>;
  hotkey(keys: string[]): Promise<void>;
  press(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  clipboardGet(): Promise<string>;
  clipboardSet(text: string): Promise<void>;
  switchDesktop(desktop: 'main' | 'pip'): Promise<void>;
}

/** 键名 → Windows 虚拟键码（覆盖 hotkey/press 的常用集合）。 */
const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b,
  enter: 0x0d, tab: 0x09, esc: 0x1b, space: 0x20, backspace: 0x08, delete: 0x2e,
  insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75,
  f7: 0x76, f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7a, f12: 0x7b,
  caps_lock: 0x14, print_screen: 0x2c, pause: 0x13,
};

function vkOf(key: string): number {
  const k = key.toLowerCase();
  if (VK[k] !== undefined) {
    return VK[k];
  }
  if (/^[a-z]$/.test(k)) {
    return k.toUpperCase().charCodeAt(0);
  }
  if (/^[0-9]$/.test(k)) {
    return k.charCodeAt(0);
  }
  if (/^0x[0-9a-f]+$/i.test(k)) {
    return parseInt(k, 16);
  }
  throw new CuError('CU_INVALID_ACTION', `不认识的键名：${key}（可用 ctrl/shift/alt/win/enter/tab/esc/a-z/0-9/f1-f12 等）`);
}

/** 复用同一份 C# 帮助类（每个 PowerShell 进程编译一次）。 */
const CS_HELPER = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class CuWin {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int nIndex);

  const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  const uint WHEEL = 0x0800, HWHEEL = 0x01000, KEYUP = 0x0002;

  public static int ScreenW() { return SystemInformation.VirtualScreen.Width; }
  public static int ScreenH() { return SystemInformation.VirtualScreen.Height; }

  static void Px(double nx, double ny, out int px, out int py) {
    int w = SystemInformation.VirtualScreen.Width;
    int h = SystemInformation.VirtualScreen.Height;
    px = (int)Math.Round(nx / 1000.0 * (w - 1)) + SystemInformation.VirtualScreen.X;
    py = (int)Math.Round(ny / 1000.0 * (h - 1)) + SystemInformation.VirtualScreen.Y;
  }

  public static void Move(double nx, double ny) {
    int x, y; Px(nx, ny, out x, out y); SetCursorPos(x, y);
  }

  public static void Click(double nx, double ny, int count, bool right) {
    int x, y; Px(nx, ny, out x, out y); SetCursorPos(x, y);
    for (int i = 0; i < count; i++) {
      mouse_event(right ? RIGHTDOWN : LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
      mouse_event(right ? RIGHTUP : LEFTUP, 0, 0, 0, UIntPtr.Zero);
      System.Threading.Thread.Sleep(40);
    }
  }

  public static void Drag(double x1, double y1, double x2, double y2) {
    int ax, ay, bx, by;
    Px(x1, y1, out ax, out ay); Px(x2, y2, out bx, out by);
    SetCursorPos(ax, ay);
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(120);
    for (int i = 1; i <= 12; i++) {
      SetCursorPos(ax + (bx - ax) * i / 12, ay + (by - ay) * i / 12);
      System.Threading.Thread.Sleep(20);
    }
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
  }

  public static void Wheel(double nx, double ny, int notches, bool horizontal) {
    int x, y; Px(nx, ny, out x, out y); SetCursorPos(x, y);
    mouse_event(horizontal ? HWHEEL : WHEEL, 0, 0, notches * 120, UIntPtr.Zero);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)]
  struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  struct INPUT { public uint type; public INPUTUNION u; }

  static void SendVk(ushort vk, bool down) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 1;
    inputs[0].u.ki.wVk = vk;
    inputs[0].u.ki.dwFlags = down ? 0u : KEYUP;
    SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
  }

  public static void Vk(ushort vk, bool down) { SendVk(vk, down); }

  public static void TypeText(string text) {
    foreach (char ch in text) {
      if (ch == '\n') { SendVk(0x0D, true); SendVk(0x0D, false); continue; }
      if (ch == '\r') continue;
      if (ch == '\t') { SendVk(0x09, true); SendVk(0x09, false); continue; }
      INPUT[] inputs = new INPUT[1];
      inputs[0].type = 1;
      inputs[0].u.ki.wVk = 0;
      inputs[0].u.ki.wScan = ch;
      inputs[0].u.ki.dwFlags = 0x0004 | 0x0002; // KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
      SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
      inputs[0].u.ki.dwFlags = 0x0004;
      SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
  }
}
`;

async function ps(script: string, timeoutMs = 20_000): Promise<string> {
  const full = `$ErrorActionPreference='Stop'\n${script}`;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  const exe = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
  const { stdout } = await execFileAsync(
    exe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
  );
  return stdout;
}

function helperScript(body: string): string {
  return `Add-Type -AssemblyName System.Windows.Forms,System.Drawing\nAdd-Type -TypeDefinition @'\n${CS_HELPER}\n'@\n${body}`;
}

/** Windows 后端（默认实现）。 */
export class WindowsCuBackend implements CuBackend {
  public async screenshot(): Promise<{ width: number; height: number; png: Buffer }> {
    const dir = await mkdtemp(join(tmpdir(), 'cu-shot-'));
    const file = join(dir, 'shot.png');
    try {
      const out = await ps(
        [
          'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
          '$b = [System.Windows.Forms.SystemInformation]::VirtualScreen',
          '$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height',
          '$g = [System.Drawing.Graphics]::FromImage($bmp)',
          '$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)',
          `$bmp.Save('${file.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)`,
          '$g.Dispose(); $bmp.Dispose()',
          'Write-Output ("{0} {1}" -f $b.Width, $b.Height)',
        ].join('\n'),
        30_000,
      );
      const [w, h] = out.trim().split(/\s+/).map(Number);
      const png = await readFile(file);
      if (!png.length) {
        throw new CuError('CU_SCREENSHOT_NOT_INTERACTIVE', '截图内容为空');
      }
      return { width: w, height: h, png };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  public async listApps(): Promise<Array<{ name: string }>> {
    const out = await ps(
      [
        '$dirs = @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs", "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")',
        "$names = @()",
        'foreach ($d in $dirs) { if (Test-Path $d) { $names += Get-ChildItem -Path $d -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName } } }',
        '$names | Sort-Object -Unique | ConvertTo-Json -Compress',
      ].join('\n'),
      30_000,
    );
    const text = out.trim();
    if (!text) {
      return [];
    }
    try {
      const arr = JSON.parse(text) as string[] | string;
      const list = Array.isArray(arr) ? arr : [arr];
      return list.filter(Boolean).map((name) => ({ name: String(name) }));
    } catch {
      return [];
    }
  }

  public async launchApp(name: string): Promise<Record<string, unknown>> {
    const safe = name.replace(/'/g, "''");
    const out = await ps(
      [
        `$name = '${safe}'`,
        'try { Start-Process -FilePath $name -ErrorAction Stop; Write-Output "resolved_target" }',
        'catch { Start-Process "shell:AppsFolder\\$name"; Write-Output "apps_folder" }',
      ].join('\n'),
      30_000,
    );
    const method = out.trim().includes('resolved_target') ? 'resolved_target' : 'apps_folder';
    return {
      app: { name },
      status: 'accepted_unverified',
      launch_method: method,
    };
  }

  public async click(x: number, y: number, clicks: number, button: 'left' | 'right'): Promise<void> {
    await ps(helperScript(`[CuWin]::Click(${x}, ${y}, ${clicks}, $${button === 'right' ? 'true' : 'false'})`));
  }

  public async hover(x: number, y: number): Promise<void> {
    await ps(helperScript(`[CuWin]::Move(${x}, ${y})`));
  }

  public async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    await ps(helperScript(`[CuWin]::Drag(${x1}, ${y1}, ${x2}, ${y2})`));
  }

  public async scroll(x: number, y: number, delta: number, horizontal: boolean): Promise<void> {
    await ps(helperScript(`[CuWin]::Wheel(${x}, ${y}, ${delta}, $${horizontal ? 'true' : 'false'})`));
  }

  public async typeText(text: string): Promise<void> {
    // 用 base64 传文本，避免 PowerShell 引号/中文转义问题
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    await ps(
      helperScript(
        `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))\n[CuWin]::TypeText($t)`,
      ),
    );
  }

  public async hotkey(keys: string[]): Promise<void> {
    const vks = keys.map((k) => vkOf(k));
    const downs = vks.map((v) => `[CuWin]::Vk(${v}, $true)`).join('\n');
    const ups = [...vks].reverse().map((v) => `[CuWin]::Vk(${v}, $false)`).join('\n');
    await ps(helperScript(`${downs}\nStart-Sleep -Milliseconds 30\n${ups}`));
  }

  public async press(key: string): Promise<void> {
    const vk = vkOf(key);
    await ps(helperScript(`[CuWin]::Vk(${vk}, $true)\n[CuWin]::Vk(${vk}, $false)`));
  }

  public async keyDown(key: string): Promise<void> {
    await ps(helperScript(`[CuWin]::Vk(${vkOf(key)}, $true)`));
  }

  public async keyUp(key: string): Promise<void> {
    await ps(helperScript(`[CuWin]::Vk(${vkOf(key)}, $false)`));
  }

  public async clipboardGet(): Promise<string> {
    const out = await ps('$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($null -eq $t) { "" } else { $t }');
    return out.replace(/\r?\n$/, '');
  }

  public async clipboardSet(text: string): Promise<void> {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    await ps(
      [
        `$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}'))`,
        'if ([string]::IsNullOrEmpty($t)) { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear() }',
        'else { Set-Clipboard -Value $t }',
      ].join('\n'),
    );
  }

  public async switchDesktop(desktop: 'main' | 'pip'): Promise<void> {
    if (desktop === 'main') {
      return; // Windows 只有主桌面
    }
    // pip 是豆包宿主私有的会话桌面，无公开 API（原实现也只在宿主内可用）
    throw new CuError('CU_INVALID_ACTION', 'pip 桌面是豆包宿主的私有会话桌面，第三方实现无法切换');
  }
}

/** 测试用：记录调用、不触碰真实桌面。 */
export class MockBackend implements CuBackend {
  public readonly calls: Array<{ op: string; args: unknown[] }> = [];
  public clipboard = 'mock-clipboard';

  private rec(op: string, ...args: unknown[]): void {
    this.calls.push({ op, args });
  }

  public async screenshot(): Promise<{ width: number; height: number; png: Buffer }> {
    this.rec('screenshot');
    // 1x1 透明 PNG
    return {
      width: 1,
      height: 1,
      png: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    };
  }
  public async listApps(): Promise<Array<{ name: string }>> {
    this.rec('list_apps');
    return [{ name: 'Notepad' }, { name: 'Calculator' }];
  }
  public async launchApp(name: string): Promise<Record<string, unknown>> {
    this.rec('launch_app', name);
    return { app: { name }, status: 'accepted_unverified', launch_method: 'resolved_target' };
  }
  public async click(x: number, y: number, clicks: number, button: string): Promise<void> {
    this.rec('click', x, y, clicks, button);
  }
  public async hover(x: number, y: number): Promise<void> {
    this.rec('hover', x, y);
  }
  public async drag(x1: number, y1: number, x2: number, y2: number): Promise<void> {
    this.rec('drag', x1, y1, x2, y2);
  }
  public async scroll(x: number, y: number, delta: number, horizontal: boolean): Promise<void> {
    this.rec('scroll', x, y, delta, horizontal);
  }
  public async typeText(text: string): Promise<void> {
    this.rec('type', text);
  }
  public async hotkey(keys: string[]): Promise<void> {
    this.rec('hotkey', keys.join('+'));
  }
  public async press(key: string): Promise<void> {
    this.rec('press', key);
  }
  public async keyDown(key: string): Promise<void> {
    this.rec('key_down', key);
  }
  public async keyUp(key: string): Promise<void> {
    this.rec('key_up', key);
  }
  public async clipboardGet(): Promise<string> {
    this.rec('get_clipboard');
    return this.clipboard;
  }
  public async clipboardSet(text: string): Promise<void> {
    this.rec('set_clipboard', text);
    this.clipboard = text;
  }
  public async switchDesktop(desktop: 'main' | 'pip'): Promise<void> {
    this.rec('switch_desktop', desktop);
  }
}
