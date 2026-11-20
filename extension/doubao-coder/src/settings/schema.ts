/**
 * 设置中心允许修改的配置白名单与归一化。
 *
 * 只暴露面板里真实使用的键：避免 webview 传入任意 key 改写整个 settings.json。
 * 不依赖 vscode，便于离线单测。
 */

export type SettingPrimitive = string | number | boolean;

export const SETTINGS_KEYS = [
  'cli.path',
  'cli.permissionMode',
  'cli.model',
  'cli.effort',
  'cli.timeoutMs',
  'desktop.port',
  'desktop.exePath',
  'desktop.workMode',
  'desktop.model',
  'desktop.reasoning',
  'model',
  'maxTokens',
  'enableInlineCompletion',
  'terminal.autoRun',
  'reviewEdits',
  'autoContinue',
  'autoContinueSeconds',
  'verify.afterAccept',
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

const ENUMS: Record<string, string[]> = {
  'cli.permissionMode': ['ask_always', 'ask_risky', 'always_allow'],
  'cli.effort': ['', 'Low', 'Medium', 'High'],
  'desktop.workMode': ['auto', 'local', 'chat'],
  'desktop.reasoning': ['', '低', '中', '高', '极高'],
};

const NUMBERS: Record<string, { min: number; max: number; integer: boolean }> = {
  'cli.timeoutMs': { min: 30_000, max: 3_600_000, integer: true },
  'desktop.port': { min: 1, max: 65_535, integer: true },
  'autoContinueSeconds': { min: 0, max: 120, integer: true },
  'maxTokens': { min: 1, max: 32_768, integer: true },
};

const BOOLEANS = new Set<string>([
  'enableInlineCompletion',
  'terminal.autoRun',
  'reviewEdits',
  'autoContinue',
  'verify.afterAccept',
]);

const STRINGS = new Set<string>([
  'cli.path',
  'cli.model',
  'desktop.exePath',
  'desktop.model',
  'model',
]);

const MAX_STRING = 1024;

export function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

export interface NormalizeResult {
  ok: boolean;
  value?: SettingPrimitive;
  error?: string;
}

/** 把 webview 传来的值转成可写入配置的类型；非法/越界直接拒绝。 */
export function normalizeSettingValue(key: string, raw: unknown): NormalizeResult {
  if (!isSettingsKey(key)) {
    return { ok: false, error: '不允许修改这个配置：' + key };
  }
  const enumValues = ENUMS[key];
  if (enumValues) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!enumValues.includes(value)) {
      return { ok: false, error: key + ' 的取值不合法：' + String(raw) };
    }
    return { ok: true, value };
  }
  const numberRule = NUMBERS[key];
  if (numberRule) {
    const value = typeof raw === 'number' ? raw : Number(String(raw ?? '').trim());
    if (!Number.isFinite(value)) {
      return { ok: false, error: key + ' 需要数字' };
    }
    const rounded = numberRule.integer ? Math.round(value) : value;
    if (rounded < numberRule.min || rounded > numberRule.max) {
      return { ok: false, error: key + ' 超出范围（' + numberRule.min + '–' + numberRule.max + '）' };
    }
    return { ok: true, value: rounded };
  }
  if (BOOLEANS.has(key)) {
    if (typeof raw !== 'boolean') {
      return { ok: false, error: key + ' 需要布尔值' };
    }
    return { ok: true, value: raw };
  }
  if (STRINGS.has(key)) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length > MAX_STRING) {
      return { ok: false, error: key + ' 太长（最多 ' + MAX_STRING + ' 字符）' };
    }
    return { ok: true, value };
  }
  return { ok: false, error: '不允许修改这个配置：' + key };
}

export function isAuthMode(value: unknown): value is 'cli' | 'desktop' | 'ark' {
  return value === 'cli' || value === 'desktop' || value === 'ark';
}
