/**
 * Agent 工具执行前的策略门（PTC / Ark 主循环共用）。
 *
 * 任务模式本来就走 policy.gate；这里补上聊天路径：
 * - `task.permission=ask`：所有非只读工具都确认；
 * - `risk`（默认）：只确认 dangerous（例如写工作区外、危险命令）；
 * - `allow`：不确认。
 *
 * `run_terminal` / `run_checks` 在工具内部已有确认逻辑，这里跳过，避免二次弹窗。
 */
import { workspaceRoot } from '../config';
import { decide } from './policy';
import type { ToolRuntime } from './tools';

const SELF_CONFIRMING = new Set(['run_terminal', 'run_checks']);

export async function guardToolCall(
  name: string,
  args: Record<string, unknown>,
  runtime: ToolRuntime,
): Promise<string | undefined> {
  if (SELF_CONFIRMING.has(name)) {
    return undefined;
  }
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  const call = { name, args };
  const decision = decide(call, runtime.config.taskPermission, root);
  if (!decision.needsConfirm) {
    return undefined;
  }
  const approved = runtime.confirmRisk
    ? await runtime.confirmRisk(call, decision.verdict)
    : false;
  if (approved) {
    return undefined;
  }
  return `用户拒绝执行（风险等级：${decision.verdict.level}，原因：${decision.verdict.reason}）。请改用只读工具，或先向用户说明再重试。`;
}
