/**
 * 任务模式（本地电脑执行面）
 *
 * 豆包桌面端的「本地电脑任务」本质是：**云端模型负责想，本地运行时负责做**
 * （它本地带 ConPTY 终端 + Python computer-use 运行时）。
 *
 * 这个模块把"做"的那一层搬进扩展：
 *   1) 先让模型给出计划（3–6 步）；
 *   2) 每轮让模型输出**一个** ```tool 动作（复用 PTC 文本协议）；
 *   3) 用 policy.ts 做风险分级 + 人工确认；
 *   4) 执行、回灌结果、进入下一步，直到模型给出最终答复或达到步数上限。
 *
 * 与具体通道解耦：只需要一个 `complete(prompt) => Promise<string>`，
 * 桌面端（askDesktop）和 Ark（chatStream）都能塞进来。
 */
import type { DoubaoConfig } from '../config';
import { log, warn } from '../log';
import { gate, type PermissionMode, type RiskVerdict, type ToolCall } from './policy';
import { parsePtc } from './ptc';
import { MAX_TOOL_RESULT_CHARS, TOOL_DEFINITIONS, executeTool, truncate, type ToolDefinition, type ToolRuntime } from './tools';

/** 单轮模型调用：输入完整提示词，返回模型全文。 */
export type CompleteFn = (prompt: string) => Promise<string>;

export interface StepRecord {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  risk: RiskVerdict['level'];
  reason: string;
  resultPreview: string;
}

export interface TaskResult {
  plan: string[];
  steps: StepRecord[];
  answer: string;
  aborted: boolean;
}

export interface TaskEvents {
  onPlan?(plan: string[]): void;
  /** 每一轮开始（用于在界面上还原豆包的「任务 / 计划」分段）。 */
  onRound?(event: { index: number; plan: string[] }): void;
  onTextDelta?(text: string): void;
  onToolStart?(event: { id: string; name: string; arguments: Record<string, unknown> }): void;
  onToolEnd?(event: { id: string; name: string; ok: boolean; content: string }): void;
  onDone?(result: TaskResult): void;
}

export interface TaskOptions {
  goal: string;
  root: string;
  config: DoubaoConfig;
  runtime: ToolRuntime;
  complete: CompleteFn;
  events: TaskEvents;
  signal?: AbortSignal;
  permission?: PermissionMode;
  maxSteps?: number;
  /** 人工确认回调（VS Code 里弹模态框）。 */
  confirm: (call: ToolCall, verdict: RiskVerdict) => Promise<boolean>;
}

const PLAN_PROMPT = (goal: string, catalog: string) => `你是本地电脑上的执行型 Agent。用户给出的任务：

"""${goal}"""

请先给出一个**可执行的最小计划**（3–6 步），每步是一句祈使句，说明要做什么、用什么手段（读文件/搜索/改文件/跑命令）。
只输出 JSON 数组，放在 \`\`\`json 代码块里，不要输出别的内容。例如：
\`\`\`json
["查看工程结构，确认入口文件", "读取入口文件并定位目标函数", "修改函数并跑一次构建验证"]
\`\`\`

可用工具（供参考，不需要在计划里写 JSON 调用）：
${catalog}`;

const ACTION_PROMPT = (goal: string, plan: string[], steps: StepRecord[]) => {
  const planText = plan.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const history = steps.length
    ? steps
        .map(
          (s) =>
            `${s.index}. ${s.tool}(${JSON.stringify(s.args)}) → ${s.ok ? '成功' : '失败'}：${s.resultPreview.slice(0, 300)}`,
        )
        .join('\n')
    : '（还没有执行任何步骤）';
  return `任务：${goal}

计划：
${planText}

已执行：
${history}

请决定**下一步的单个动作**：
- 如果还需要操作本地电脑，输出一个 \`\`\`tool 代码块（JSON：{"name":..., "arguments":{...}}），只输出一个；
- 如果任务已完成，直接输出最终答复（中文，简洁，给出改了哪些文件/跑了什么命令/结论），不要再输出 tool 块。`;
};

function catalogText(extra: ToolDefinition[] = []): string {
  return [...TOOL_DEFINITIONS, ...extra].map((t) => `- ${t.name}: ${t.description}`).join('\n');
}

/** 从模型输出里抠出计划数组。 */
export function parsePlan(text: string): string[] {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start < 0 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export class TaskRunner {
  constructor(private readonly options: TaskOptions) {}

  public async run(): Promise<TaskResult> {
    const { goal, root, complete, events, signal, maxSteps = 30 } = this.options;
    const permission: PermissionMode = this.options.permission ?? 'risk';
    const steps: StepRecord[] = [];

    // 1) 计划
    let plan: string[] = [];
    try {
      const planRaw = await complete(PLAN_PROMPT(goal, catalogText(this.options.runtime.externalTools?.definitions() ?? [])));
      plan = parsePlan(planRaw);
    } catch (err) {
      warn('任务模式：规划失败', err instanceof Error ? err.message : String(err));
    }
    if (plan.length === 0) {
      plan = ['直接执行任务并给出结论'];
    }
    events.onPlan?.(plan);
    log('任务模式：计划', plan.join(' | '), `permission=${permission}`);

    // 2) 逐步执行
    let answer = '';
    let aborted = false;
    for (let step = 1; step <= maxSteps; step += 1) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      try {
        events.onRound?.({ index: step, plan });
      } catch {
        /* 事件回调失败不影响执行 */
      }
      let raw: string;
      try {
        raw = await complete(ACTION_PROMPT(goal, plan, steps));
      } catch (err) {
        answer = `执行中断：${err instanceof Error ? err.message : String(err)}`;
        break;
      }

      const parsed = parsePtc(raw);
      if (parsed.prose) {
        events.onTextDelta?.(parsed.prose);
      }
      const action = parsed.calls[0];
      if (!action) {
        answer = parsed.prose || raw.trim();
        break;
      }
      if (action.error) {
        steps.push({
          index: step,
          tool: 'invalid',
          args: {},
          ok: false,
          risk: 'safe',
          reason: action.error,
          resultPreview: action.error,
        });
        continue;
      }

      const call: ToolCall = { name: action.name, args: action.arguments };
      const verdict = await gate(call, permission, root, this.options.confirm);
      const decision = verdict.verdict;
      if (!verdict.allowed) {
        const denied = verdict.deniedReason ?? '被策略拒绝';
        steps.push({
          index: step,
          tool: call.name,
          args: call.args,
          ok: false,
          risk: decision.level,
          reason: decision.reason,
          resultPreview: denied,
        });
        events.onToolEnd?.({ id: action.id, name: call.name, ok: false, content: denied });
        continue;
      }

      events.onToolStart?.({ id: action.id, name: call.name, arguments: call.args });
      let ok = false;
      let content = '';
      try {
        const outcome = await executeTool(call.name, call.args, this.options.runtime);
        ok = outcome.ok;
        content = truncate(outcome.content, MAX_TOOL_RESULT_CHARS);
      } catch (err) {
        content = `工具执行异常：${err instanceof Error ? err.message : String(err)}`;
      }
      events.onToolEnd?.({ id: action.id, name: call.name, ok, content });
      steps.push({
        index: step,
        tool: call.name,
        args: call.args,
        ok,
        risk: decision.level,
        reason: decision.reason,
        resultPreview: content,
      });
    }

    if (!answer) {
      answer = steps.length
        ? `已完成 ${steps.length} 步；最后一步：${steps[steps.length - 1].tool}（${steps[steps.length - 1].ok ? '成功' : '失败'}）。`
        : '没有可执行的步骤。';
    }

    const result: TaskResult = { plan, steps, answer, aborted };
    events.onDone?.(result);
    return result;
  }
}
