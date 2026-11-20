/**
 * 「豆包是不是没回」的判定。
 *
 * 只看「有没有正文」会误报：长任务里豆包可能在连续执行代码/读文件，
 * 几十秒没有正文，但计时和步骤一直在变（`busy` / `executing`）。
 * 这种情况下只能算「还在干活」，不能提示“没有看到豆包的回复”。
 */
export interface StallInput {
  /** 是否已经看到过正文（或工具块文本）。 */
  sawReply: boolean;
  /** 距上一次有任何活动（正文/分块/计时/执行态）过去的毫秒数。 */
  idleMs: number;
  /** 页面上的停止按钮是否还在（豆包仍在生成/执行）。 */
  busy: boolean;
  /** 是否出现「正在执行代码」。 */
  executing: boolean;
  /** 阈值，默认 90 秒。 */
  thresholdMs?: number;
}

export function isStalled(input: StallInput): boolean {
  if (input.sawReply) {
    return false;
  }
  if (input.busy || input.executing) {
    return false;
  }
  return input.idleMs > (input.thresholdMs ?? 90_000);
}

export type StallDecision = 'ok' | 'retry' | 'give-up';

/**
 * 「没动静」出现后的处理策略：先重试几次，仍没动静才提示用户。
 * 用户明确要求：重试几次「继续说」都没反应，才报 90 秒没有任何动静。
 */
export function stallDecision(input: StallInput & { retries: number; maxRetries?: number }): StallDecision {
  if (!isStalled(input)) {
    return 'ok';
  }
  return input.retries < (input.maxRetries ?? 2) ? 'retry' : 'give-up';
}
