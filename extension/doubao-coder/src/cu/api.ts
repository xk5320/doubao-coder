/**
 * 对外 API（对照 `computer_use/_windows/public/api.py` 的 `__all__`）
 *
 * 用法：
 *   const cu = createComputerUse();          // 默认 Windows 后端
 *   const shot = await cu.screenshot('t1');  // 落盘 + 记观察
 *   await cu.click(500, 300);                // 归一化坐标
 *   const blocks = renderEnvelope(cu.executor.toEnvelope({ ok: true }));
 */
export { ComputerUse, CuError, coordinate, scrollDelta, waitSeconds, normalizeKey } from './actions';
export type { CuApiOptions } from './actions';
export { CellExecutor, sanitizeArgs } from './cell';
export { WindowsCuBackend, MockBackend } from './backend';
export type { CuBackend } from './backend';
export { DEFAULT_PROFILE, ProfileState, ProfileConflictError } from './profile';
export type { GacProfile } from './profile';
export {
  renderEnvelope,
  blocksToText,
  resultStatus,
  truncateCounted,
  isStableCode,
  fallbackCode,
  STATE_CHANGED_CODES,
  INVALID_ACTION_CODES,
  BLOCKED_CODES,
} from './envelope';
export type { CellEnvelope, CellObservation, CellAction, ContentBlock, ResultStatus } from './envelope';
export {
  encodeFrame,
  decodeFrame,
  encodeCommand,
  decodeCommand,
  encodeResponse,
  decodeResponse,
  encodeScreenshotResponse,
  decodeScreenshotResponse,
  FRAME_MAGIC,
  MAX_FRAME_SIZE,
  MAX_PLAINTEXT_SIZE,
  ModuleId,
  Command,
  WireError,
} from './wire';

import { ComputerUse } from './actions';
import { WindowsCuBackend } from './backend';
import { CellExecutor } from './cell';
import type { DoubaoConfig } from '../config';

/** 默认：Windows 后端 + 新 cell。 */
export function createComputerUse(options?: { show?: boolean; imageDir?: string }): ComputerUse {
  return new ComputerUse({
    backend: new WindowsCuBackend(),
    cell: new CellExecutor(),
    ...options,
  });
}

/**
 * 按配置选择后端：
 *   装了豆包 + 有 GAC 通道 → 直接用安装目录里的 SDK；否则退化到本地 Win32。
 * 没装豆包时会弹安装引导（promptIfMissing=true 时）。
 */
export async function createComputerUseFromConfig(
  config: DoubaoConfig,
  options?: { imageDir?: string; promptIfMissing?: boolean },
): Promise<{ cu: ComputerUse; kind: 'doubao' | 'win32'; reason?: string }> {
  const { selectBackend } = await import('./backend-select');
  const sel = await selectBackend({
    mode: config.computerBackend,
    installPath: config.installPath,
    pythonPath: config.pythonPath,
    promptIfMissing: options?.promptIfMissing ?? true,
  });
  return {
    cu: new ComputerUse({ backend: sel.backend, cell: new CellExecutor(), imageDir: options?.imageDir }),
    kind: sel.kind,
    reason: sel.reason,
  };
}
