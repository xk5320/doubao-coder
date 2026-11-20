/**
 * 对话区「反馈块」的统一模型。
 *
 * 豆包桌面端一条助手回复不是一段 Markdown，而是按 `data-plugin-identifier` 排好序的块：
 *  - block_type:10091  preamble-elapsed  —— 同步状态（已处理 / 共用时 的计时分隔线）
 *  - block_type:10040  thinking_block    —— 一步「执行反馈」（已执行代码 / 已读取… / 正在… / 超时）
 *  - block_type:10000  markdown          —— 正文
 * 另外还有图片块、快捷回复块等，这里不建模。
 *
 * 扩展里所有显示路径（侧边栏、历史导入、定时同步）都吃这个模型，
 * 这样「页面上是什么顺序、什么文案」在扩展里就是同一个顺序、同一份文案。
 */

export type ReplyBlockKind = 'text' | 'code' | 'status' | 'step';

export type ReplyBlockState = 'done' | 'running' | 'error';

export interface ReplyBlock {
  kind: ReplyBlockKind;
  /** 正文 Markdown / 命令行 / 计时文案 / 步骤标题。 */
  text: string;
  /** step 的展开详情（输出、结果），豆包折叠时可能为空。 */
  detail?: string;
  /** 步骤里附带的图片（生图结果）。 */
  images?: string[];
  /** step 的执行态：已完成 / 进行中 / 失败。 */
  state?: ReplyBlockState;
  /** step 的图标类型（豆包每类动作一个图标）：code / read / search / edit / write / browser / skill / step。 */
  icon?: string;
  /** code 块的输出（旧通道兼容）。 */
  output?: string;
}

/** 「已处理 5 分 52 秒」「共用时 12 秒」「1 小时 2 分」→ 秒数；读不到返回 -1。 */
export function parseElapsedSeconds(text: string): number {
  const raw = String(text || '');
  const hours = /(\d+)\s*(?:小时|时)/.exec(raw);
  const minutes = /(\d+)\s*分/.exec(raw);
  const seconds = /(\d+)\s*秒/.exec(raw);
  if (!hours && !minutes && !seconds) {
    return -1;
  }
  return (
    (hours ? Number(hours[1]) * 3600 : 0) +
    (minutes ? Number(minutes[1]) * 60 : 0) +
    (seconds ? Number(seconds[1]) : 0)
  );
}

/** 与豆包一致的时长写法：「52 秒」/「5 分 52 秒」/「1 小时 2 分 3 秒」。 */
export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h} 小时 ${m} 分 ${s} 秒`;
  }
  if (m > 0) {
    return `${m} 分 ${s} 秒`;
  }
  return `${s} 秒`;
}

/** 挂钟文案：运行中「已处理 5 分 52 秒」，结束后「共用时 4 分 55 秒」。 */
export function formatElapsedLabel(seconds: number, verb: '已处理' | '共用时' = '已处理'): string {
  return `${verb} ${formatElapsed(seconds)}`;
}

/** 计时文案是否表示「本轮已结束」（豆包结束后把 已处理 换成 共用时）。 */
export function isFinishedElapsed(text: string): boolean {
  return /^\s*共用时/.test(String(text || ''));
}

export type StepIconKind = 'code' | 'read' | 'search' | 'edit' | 'write' | 'browser' | 'skill' | 'step';

const STEP_ICONS: StepIconKind[] = ['code', 'read', 'search', 'edit', 'write', 'browser', 'skill', 'step'];

/**
 * 反馈步骤的图标类型。
 * 优先用页面上真实图标（豆包的 shellexec/fileview…），没有就按标题语义兜底。
 */
export function inferStepIcon(text: string, domIcon?: string): StepIconKind {
  const title = String(text || '').trim();
  // 先按标题语义（用户看到的是「已查找文件内容」，图标就该是放大镜，哪怕底层是 fileview）
  if (/^(正在|已)?执行(代码|命令)/.test(title)) {
    return 'code';
  }
  if (/^(正在|已)?读取|^(正在|已)?查看文件/.test(title)) {
    return 'read';
  }
  if (/^(正在|已)?查找|查找文件|搜索文件|grep/i.test(title)) {
    return 'search';
  }
  if (/^(正在|已)?(写入|修改|编辑|应用)/.test(title)) {
    return 'edit';
  }
  if (/浏览器|网页|browser/i.test(title)) {
    return 'browser';
  }
  if (/技能|插件|skill|plugin/i.test(title)) {
    return 'skill';
  }
  // 标题看不出类型时，用页面上的真实图标兜底（豆包：shellexec=终端、fileview=文件）
  const explicit = String(domIcon || '').trim();
  if (STEP_ICONS.indexOf(explicit as StepIconKind) >= 0) {
    return explicit as StepIconKind;
  }
  const lower = explicit.toLowerCase();
  if (lower.indexOf('shellexec') >= 0 || lower.indexOf('shellview') >= 0) {
    return 'code';
  }
  if (lower.indexOf('fileview') >= 0) {
    return 'read';
  }
  return 'step';
}

/** 把页面回传的任意块数组收拢成合法模型，丢掉空块。 */
export function normalizeReplyBlocks(input: unknown): ReplyBlock[] {
  const list = Array.isArray(input) ? input : [];
  const out: ReplyBlock[] = [];
  for (const item of list as Array<Record<string, unknown>>) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const kind = item.kind;
    const text = String(item.text == null ? '' : item.text).trim();
    if (kind !== 'text' && kind !== 'code' && kind !== 'status' && kind !== 'step') {
      continue;
    }
    if (!text) {
      continue;
    }
    const block: ReplyBlock = { kind, text };
    if (kind === 'step') {
      const state = item.state;
      block.state = state === 'running' || state === 'error' ? state : 'done';
      block.icon = inferStepIcon(text, typeof item.icon === 'string' ? item.icon : '');
      const detail = String(item.detail == null ? '' : item.detail).trim();
      if (detail && detail !== text) {
        block.detail = detail;
      }
      const rawImages = Array.isArray(item.images) ? (item.images as unknown[]) : [];
      const images = rawImages
        .filter((src): src is string => typeof src === 'string' && /^(https?:|data:|file:)/.test(src))
        .slice(0, 8);
      if (images.length) {
        block.images = images;
      }
    }
    if (kind === 'code' && item.output) {
      block.output = String(item.output);
    }
    out.push(block);
  }
  return out;
}

/** 只取正文块拼成 Markdown：用于保存、PTC 解析、历史回放。 */
export function blocksToMarkdown(blocks: ReplyBlock[]): string {
  return blocks
    .filter((block) => block.kind === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n');
}

/** 步骤标题的首行（豆包只显示一行，超出用省略号）。 */
export function stepTitle(block: ReplyBlock): string {
  const line = String(block.text || '').split('\n')[0].trim();
  return line || String(block.text || '');
}
