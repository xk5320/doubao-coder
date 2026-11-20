/**
 * 系统提示词里的「当前模型」一行。
 *
 * 桌面端通道真正生效的是豆包界面里选中的模型（如 DeepSeek V4.1 Flash），
 * 不是 Ark 的 config.model；这里统一算一次，保证「工具栏显示 / 提示词 / 实际调用」三者一致。
 */

export interface EffectiveModelInput {
  /** local = 工作任务·本地电脑，chat = 对话 */
  mode: 'local' | 'chat';
  /** 面板里记住的本轮任务模型 / 推理强度 */
  taskModel?: string;
  taskReasoning?: string;
  /** 桌面端当前模型 / 推理强度 */
  desktopModel?: string;
  desktopReasoning?: string;
  /** 配置里的桌面端模型（用户上次选中的默认值） */
  configDesktopModel?: string;
  configDesktopReasoning?: string;
  /** Ark / CLI 模型（只在非桌面端通道使用） */
  configModel?: string;
  authMode?: 'cli' | 'desktop' | 'ark';
}

/** 当前生效的模型与推理强度（桌面端优先，Ark 兜底）。 */
export function pickEffectiveModel(input: EffectiveModelInput): { model: string; reasoning: string } {
  if (input.authMode === 'ark' || input.authMode === 'cli') {
    return { model: String(input.configModel || '').trim() || '未指定', reasoning: '' };
  }
  if (input.mode === 'chat') {
    // 对话模式下桌面端只有「快速/专家」，推理强度不展示。
    const chatModel = input.desktopModel || input.configDesktopModel || input.configModel || '';
    return { model: String(chatModel).trim() || '未指定', reasoning: String(input.desktopReasoning || '').trim() };
  }
  // 本地电脑模式：面板记住的 > 用户默认配置 > Ark 模型。
  // 不要用 desktopModel 兜底——它可能还停在对话模式的「快速」。
  const model = input.taskModel || input.configDesktopModel || input.configModel || '';
  const reasoning = input.taskReasoning || input.configDesktopReasoning || '';
  return { model: String(model).trim() || '未指定', reasoning: String(reasoning).trim() };
}

/** 与界面一致的文案：当前模型：DeepSeek V4.1 Flash（推理强度：高）。 */
export function describeModel(model: string, reasoning?: string): string {
  const name = String(model || '').trim() || '未指定';
  const level = String(reasoning || '').trim();
  return `当前模型：${name}${level ? `（推理强度：${level}）` : ''}`;
}
