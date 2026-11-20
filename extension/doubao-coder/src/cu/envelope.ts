/**
 * 结果 envelope 渲染移植（对照 `gac_runtime/envelope.py`）
 *
 * 这一层决定**模型到底看到什么**：不是 action 列表，而是一段确定性文本：
 *   [result status=ok] [output]… [progress confirmed=2 possible=0]
 *   [obs scope=screen tag=shot1] (image) / 文本观察
 *   [next] READY: …
 *
 * 只做"数据 → 文本/图像内容块"的映射，不含任何策略判断（与原实现一致）。
 */
import type { GacProfile } from './profile';

export type ResultStatus = 'ok' | 'error' | 'timeout' | 'state_changed' | 'invalid_action' | 'blocked';

/** 状态改变类错误码（`envelope.py:35-44`）。 */
export const STATE_CHANGED_CODES = [
  'CU_AX_ELEMENT_INVALID',
  'CU_APP_CONTEXT_STALE',
  'CU_APP_POINT_OCCLUDED',
  'CU_SCREENSHOT_TARGET_MISMATCH',
  'CU_WINDOW_BLOCKED_BY_MODAL',
  'CU_WINDOW_GONE',
] as const;

/** 非法动作类错误码（`envelope.py:45-66`）。 */
export const INVALID_ACTION_CODES = [
  'CU_AX_ACTION_REFUSED',
  'CU_AX_APP_NOT_RUNNING',
  'CU_AX_APP_NOT_SURFACE',
  'CU_AX_ARG_SHAPE',
  'CU_AX_FIND_EMPTY',
  'CU_APP_TARGET_REQUIRED',
  'CU_APP_TARGET_SHAPE',
  'CU_BAD_HOTKEY',
  'CU_INVALID_ACTION',
  'CU_SCROLL_DELTA',
  'CU_SCREENSHOT_NOT_INTERACTIVE',
  'CU_SCREENSHOT_TARGET_REQUIRED',
  'CU_SCROLL_PAGE',
  'CU_UNKNOWN_API',
  'CU_WAIT_SECONDS',
  'CU_WINDOW_UNKNOWN',
  'INVALID_OR_EXPIRED_REF',
  'PY_COORDINATE_SPACE_ERROR',
] as const;

/** 明确阻断（`envelope.py:67-72`）。 */
export const BLOCKED_CODES = ['CNGC_MACOS_GUI_BYPASS', 'CU_APP_NO_EFFECT_REPEAT'] as const;

/** 稳定码格式：^[A-Z][A-Z0-9_]{2,47}$ 或 actor_k…（`envelope.py:30-31,129-132`）。 */
export function isStableCode(code: string): boolean {
  return /^[A-Z][A-Z0-9_]{2,47}$/.test(code) || /^actor_k[A-Z][A-Za-z0-9]{0,56}$/.test(code);
}

/** 无稳定码时：PY_<ExceptionType>（CamelCase → UPPER_SNAKE）。 */
export function fallbackCode(exceptionType: string): string {
  const snake = exceptionType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  return `PY_${snake}`;
}

export interface CellAction {
  lib: string;
  op: string;
  args: unknown[];
  t_ms: number;
  state?: 'attempted' | 'completed' | 'rejected' | 'dispatched';
}

export interface CellObservation {
  kind: 'dom' | 'image';
  scope: string;
  superseded: boolean;
  text?: string;
  path?: string;
  tag?: string;
  width?: number;
  height?: number;
  mime_type?: string;
  clipped?: number;
  state?: Record<string, unknown>;
}

export interface CellExc {
  type: string;
  message: string;
  lineno?: number;
  traceback?: string;
  code?: string;
}

export interface CellEnvelope {
  v: 1;
  ok: boolean;
  timed_out: boolean;
  elapsed_ms: number;
  stdout: string;
  stderr: string;
  exc: CellExc | null;
  actions: CellAction[];
  actions_total: number;
  actions_possible: number;
  observations: CellObservation[];
  images: Array<{ path: string; tag?: string; w: number; h: number; mime_type: string }>;
  gac_profile: GacProfile;
  truncated?: Record<string, number>;
  auto_observation?: Record<string, unknown>;
}

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  /** 图像以 data URL 或文件路径表达；原实现直接给 bytes 交给宿主转 image block。 */
  data?: string;
  mimeType?: string;
}

/** 判定 status（`envelope.py:145-165`）。 */
export function resultStatus(env: Pick<CellEnvelope, 'ok' | 'timed_out' | 'exc'>): ResultStatus {
  if (env.timed_out) {
    return 'timeout';
  }
  if (env.ok && !env.exc) {
    return 'ok';
  }
  const code = env.exc?.code;
  if (code && (STATE_CHANGED_CODES as readonly string[]).includes(code)) {
    return 'state_changed';
  }
  if (code && (INVALID_ACTION_CODES as readonly string[]).includes(code)) {
    return 'invalid_action';
  }
  if (code && (BLOCKED_CODES as readonly string[]).includes(code)) {
    return 'blocked';
  }
  return 'error';
}

/** 截断：保留 limit-64 字符，前 2/3 + 后 1/3，中间插提示（`envelope.py:94-102`）。 */
export function truncateCounted(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const keep = Math.max(0, limit - 64);
  const head = Math.floor((keep * 2) / 3);
  const tail = keep - head;
  const cut = text.length - keep;
  return `${text.slice(0, head)}\n... ${cut} characters cut ...\n${text.slice(text.length - tail)}`;
}

function opsText(actions: CellAction[], profile: GacProfile): string {
  const recent = actions.slice(-profile.progress_ops_max);
  return recent
    .map((a) => {
      const label = `${a.op}(${a.args.map((v) => String(v)).join(',')})`;
      const clipped = label.length > profile.operation_label_limit ? `${label.slice(0, profile.operation_label_limit)}…` : label;
      return `  ${clipped}${a.state ? ` [${a.state}]` : ''}`;
    })
    .join('\n');
}

/**
 * 把 cell envelope 渲染成模型可见的内容块。
 * 顺序固定：result → output → progress → error → obs → truncated → next。
 */
export function renderEnvelope(env: CellEnvelope): ContentBlock[] {
  const profile = env.gac_profile;
  const status = resultStatus(env);
  const blocks: ContentBlock[] = [];
  const text: string[] = [];

  text.push(`[result status=${status}${env.ok ? '' : ' ok=false'}]`);
  if (env.elapsed_ms) {
    text.push(`[time] ${env.elapsed_ms}ms`);
  }
  if (env.stdout) {
    text.push('[output]');
    text.push(truncateCounted(env.stdout, profile.stdout_render_limit));
  }
  if (env.stderr) {
    text.push('[stderr]');
    text.push(truncateCounted(env.stderr, profile.stderr_render_limit));
  }
  text.push(`[progress confirmed=${env.actions_total} possible=${env.actions_possible}]`);
  const ops = opsText(env.actions, profile);
  if (ops) {
    text.push(`[progress ops="${env.actions.length}"]\n${ops}`);
  }
  if (env.exc && status !== 'timeout') {
    const code = env.exc.code ?? fallbackCode(env.exc.type);
    const tag = status === 'state_changed' ? 'state_changed' : 'error';
    text.push(`[${tag} code=${code}] ${env.exc.message}`);
    if (env.exc.traceback && profile.error_render_limit > 0) {
      text.push(truncateCounted(env.exc.traceback, profile.error_render_limit));
    }
  }

  if (text.length) {
    blocks.push({ type: 'text', text: text.join('\n') });
  }

  // 观察：文本累积，图像单独成块（原实现遇图像先 flush 文本）
  let obsText: string[] = [];
  const flush = (): void => {
    if (obsText.length) {
      blocks.push({ type: 'text', text: obsText.join('\n') });
      obsText = [];
    }
  };

  for (const obs of env.observations) {
    if (obs.kind === 'image') {
      flush();
      const head = `[obs scope=${obs.scope}${obs.tag ? ` tag=${obs.tag}` : ''}] ${obs.width ?? 0}x${obs.height ?? 0} ${obs.mime_type ?? 'image/png'}${obs.superseded ? ' (superseded)' : ''}`;
      blocks.push({ type: 'text', text: head });
      if (obs.path) {
        blocks.push({ type: 'image', data: obs.path, mimeType: obs.mime_type ?? 'image/png' });
      }
      continue;
    }
    // ax_tree 豁免渲染层截断（仍受 cell 预算约束）
    const limit = obs.scope === 'ax_tree' ? Number.MAX_SAFE_INTEGER : profile.observation_render_limit;
    const body = truncateCounted(obs.text ?? '', limit);
    obsText.push(`[obs scope=${obs.scope}${obs.tag ? ` tag=${obs.tag}` : ''}${obs.superseded ? ' superseded' : ''}]\n${body}`);
  }
  flush();

  const truncated = env.truncated ?? {};
  const cutKeys = Object.keys(truncated).filter((k) => (truncated[k] ?? 0) > 0);
  if (cutKeys.length) {
    blocks.push({ type: 'text', text: `[truncated ${cutKeys.map((k) => `${k}=${truncated[k]}`).join(' ')}]` });
  }

  blocks.push({ type: 'text', text: '[next] READY: 如需继续，重新截图后再定位坐标；不要重复同一个无效动作。' });
  return blocks;
}

/** 便于日志/调试：把内容块拼成纯文本（图像用占位符）。 */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => (b.type === 'image' ? `[image ${b.mimeType ?? ''} ${b.data ?? ''}]` : (b.text ?? '')))
    .join('\n');
}
