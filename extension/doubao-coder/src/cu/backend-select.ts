/**
 * 后端选择：优先用豆包安装目录里的官方 SDK，不行才退化到本地 Win32 实现。
 *
 * 选择顺序（`doubao.computer.backend`）：
 *   auto（默认）  有 GAC 通道 → 豆包 SDK；否则 → Win32，并在日志/提示里说明原因
 *   doubao       强制 SDK（不可用就抛错，让用户知道没接上）
 *   win32        强制本地实现
 *
 * 没装豆包时，`auto` 会先走安装引导（requireInstall）。
 */
import * as vscode from 'vscode';
import type { CuBackend } from './backend';
import { WindowsCuBackend } from './backend';
import { DoubaoSdkBackend } from './doubao-bridge';
import { detectInstall, probeGacChannel, requireInstall, type DoubaoInstall } from '../doubao/install';
import { log, warn } from '../log';

export type BackendMode = 'auto' | 'doubao' | 'win32';

export interface BackendSelection {
  backend: CuBackend;
  /** 实际使用的后端。 */
  kind: 'doubao' | 'win32';
  install?: DoubaoInstall;
  /** 为什么没用豆包 SDK。 */
  reason?: string;
}

export async function selectBackend(options: {
  mode?: BackendMode;
  installPath?: string;
  pythonPath?: string;
  /** 是否在没有安装时弹安装引导（命令场景 true，激活自检 false）。 */
  promptIfMissing?: boolean;
}): Promise<BackendSelection> {
  const mode: BackendMode = options.mode ?? 'auto';
  const install = await detectInstall(options.installPath);

  if (mode === 'win32') {
    return { backend: new WindowsCuBackend(), kind: 'win32', install, reason: '配置强制使用本地 Win32 后端' };
  }

  if (!install) {
    if (options.promptIfMissing) {
      await requireInstall(options.installPath);
    }
    warn('未检测到豆包安装，退化为本地 Win32 后端');
    return { backend: new WindowsCuBackend(), kind: 'win32', reason: '未安装豆包（或未找到安装路径）' };
  }

  if (!install.hasGacRuntime) {
    return { backend: new WindowsCuBackend(), kind: 'win32', install, reason: '豆包安装目录里没有 gac_runtime（版本过旧）' };
  }

  const probe = await probeGacChannel(install, options.pythonPath);
  if (probe.available) {
    log('使用豆包安装目录里的 Computer Use SDK', probe.reason);
    return { backend: new DoubaoSdkBackend(install, options.pythonPath), kind: 'doubao', install };
  }

  if (mode === 'doubao') {
    throw new Error(`强制使用豆包 SDK 失败：${probe.reason}`);
  }

  warn('GAC 通道不可用，退化为本地 Win32 后端', probe.reason);
  return { backend: new WindowsCuBackend(), kind: 'win32', install, reason: probe.reason };
}

/** 给状态栏/提示用的一句话说明。 */
export function describeSelection(sel: BackendSelection): string {
  if (sel.kind === 'doubao') {
    return `使用豆包安装目录的 Computer Use SDK（${sel.install?.version ?? '?'}）`;
  }
  const base = '使用本地 Win32 后端（SendInput + System.Drawing）';
  return sel.reason ? `${base}；原因：${sel.reason}` : base;
}

/** 诊断命令：把"检测到什么 / 用哪个后端 / 为什么"打印出来。 */
export async function diagnoseInstall(options: { installPath?: string; pythonPath?: string }): Promise<string[]> {
  const lines: string[] = [];
  const install = await detectInstall(options.installPath);
  if (!install) {
    lines.push('✗ 没有找到豆包安装（检测：%LOCALAPPDATA%\\Doubao\\Application\\app\\Doubao.exe）');
    lines.push('  → 请先安装豆包，或用命令「豆包: 设置安装路径」指定。');
    return lines;
  }
  lines.push(`✓ 安装目录：${install.appDir}`);
  lines.push(`  版本：${install.version ?? '?'}（channel ${install.channel ?? '?'}）`);
  lines.push(`  Computer Use SDK：${install.hasGacRuntime ? install.pythonPackagesDir : '缺失'}`);
  lines.push(`  ConPTY：${install.hasConpty ? '有' : '缺'}；MCP 宿主：${install.hasMcpHelper ? '有' : '缺'}；runtime 组件：${install.hasRuntimeBundle ? '有' : '缺'}`);
  const probe = await probeGacChannel(install, options.pythonPath);
  lines.push(`${probe.available ? '✓' : '✗'} GAC 执行通道：${probe.reason}`);
  const sel = await selectBackend({ ...options, mode: 'auto' });
  lines.push(`→ 实际后端：${describeSelection(sel)}`);
  return lines;
}

/** 供命令面板使用：把诊断结果同时写日志与弹窗。 */
export async function showDiagnostics(options: { installPath?: string; pythonPath?: string }): Promise<void> {
  const lines = await diagnoseInstall(options);
  for (const line of lines) {
    log('[诊断] ' + line);
  }
  const pick = await vscode.window.showInformationMessage(
    lines.join('\n'),
    { modal: true, detail: '这些信息也会写入「豆包编程助手」输出面板。' },
    '打开日志',
  );
  if (pick === '打开日志') {
    await vscode.commands.executeCommand('doubao.showLogs');
  }
}
