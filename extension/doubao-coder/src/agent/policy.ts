/**
 * 本地执行策略（对齐豆包「本地电脑」的三档确认）
 *
 *   始终询问  ask   —— 任何有副作用的操作都弹确认
 *   按需确认  risk  —— 只对"有风险/危险"的操作弹确认（默认）
 *   全部允许  allow —— 不弹确认，但全部写日志
 *
 * 这是把豆包桌面端"本地电脑任务"的执行面搬进扩展时最关键的一层：
 * 远程模型只负责"想"，本地这一步负责"敢不敢做"。
 */
import * as path from 'node:path';

export type PermissionMode = 'ask' | 'risk' | 'allow';
export type RiskLevel = 'safe' | 'risky' | 'dangerous';

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface RiskVerdict {
  level: RiskLevel;
  reason: string;
}

export interface GateResult {
  allowed: boolean;
  /** 用户拒绝或策略拒绝的原因（用于回灌给模型）。 */
  deniedReason?: string;
}

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'grep', 'get_diagnostics']);

/** 只读/无害的命令前缀（大小写不敏感，匹配命令首个 token 或前两个 token）。 */
const SAFE_COMMANDS = [
  'dir', 'ls', 'cat', 'type', 'head', 'tail', 'more', 'tree', 'pwd', 'echo', 'where', 'which',
  'node -v', 'node --version', 'npm -v', 'npm --version', 'python --version', 'git status',
  'git log', 'git diff', 'git branch', 'git show', 'get-childitem', 'get-content', 'select-string',
  'test-path', 'measure-object', 'resolve-path', 'findstr', 'rg', 'grep', 'wc', 'du', 'df', 'stat',
];

/** 明确危险：破坏性/提权/远程执行/推送。 */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, why: '递归删除文件' },
  { re: /\b(del|erase)\s+\/[sfq]/i, why: '强制删除文件' },
  { re: /\brmdir\s+\/s/i, why: '递归删除目录' },
  { re: /\bformat\s+[a-z]:/i, why: '格式化磁盘' },
  { re: /\b(shutdown|reboot|logoff)\b/i, why: '关机/重启' },
  { re: /\bgit\s+push\b.*(--force|-f)\b/i, why: '强制推送远端' },
  { re: /\bgit\s+push\b/i, why: '推送到远端仓库' },
  { re: /\b(reg\s+(add|delete)|sc\.exe\s+(create|delete)|sc\s+(create|delete))\b/i, why: '修改注册表/系统服务' },
  { re: /\bnet\s+user\b/i, why: '修改本地账户' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i, why: '从网络下载并直接执行脚本' },
  { re: /\b(iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(iex|invoke-expression)\b/i, why: '下载并执行远程脚本' },
  { re: /\bset-executionpolicy\b/i, why: '修改 PowerShell 执行策略' },
  { re: /\b(powershell|pwsh)\b[^\n]*\s-(enc|encodedcommand)\b/i, why: '执行 Base64 编码的 PowerShell 命令' },
  { re: /\b(iex|invoke-expression)\b/i, why: '动态执行表达式' },
  { re: /\b(taskkill|stop-process)\b/i, why: '结束进程' },
  { re: /\b(diskpart|bcdedit|vssadmin)\b/i, why: '磁盘/引导级操作' },
  { re: /\bcipher\s+\/w\b/i, why: '擦除磁盘空闲空间' },
  { re: /\bchmod\s+777\b/i, why: '开放全部权限' },
  { re: /\bsudo\b/i, why: '提权执行' },
];

/** 有副作用但通常可接受：构建、安装、提交、运行项目脚本。 */
const RISKY_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\b(npm|pnpm|yarn)\s+(install|i|add|update|upgrade)\b/i, why: '安装/升级依赖（会改 lockfile 与 node_modules）' },
  { re: /\b(npm|pnpm|yarn)\s+run\b/i, why: '运行项目脚本' },
  { re: /\bgit\s+(commit|merge|rebase|reset|checkout|clean|stash)\b/i, why: '修改仓库状态' },
  { re: /\b(python|python3|py|node|ts-node|npx)\b/i, why: '执行脚本/程序' },
  { re: /\b(cargo|go|dotnet|mvn|gradle|make|cmake|msbuild)\b/i, why: '构建/编译' },
  { re: /\b(pip|pip3)\s+(install|uninstall)\b/i, why: '安装/卸载 Python 包' },
  { re: /\b(rm|del|erase|rmdir|move|mv|copy|cp|xcopy|robocopy)\b/i, why: '移动/复制/删除文件' },
  { re: /(^|[^>])>(?!>)/, why: '重定向覆盖文件' },
  { re: /\b(curl|wget|invoke-webrequest|irm|iwr)\b/i, why: '访问网络' },
  { re: /\bdocker\b/i, why: '操作容器' },
  { re: /\b(ps|powershell)\b.*\b(remove-item|set-content|out-file)\b/i, why: 'PowerShell 写/删文件' },
];

function firstTokens(command: string): string {
  return command.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 判断一条 shell 命令的风险等级。 */
export function classifyCommand(command: string, root: string): RiskVerdict {
  const cmd = firstTokens(command);
  if (!cmd) {
    return { level: 'safe', reason: '空命令' };
  }
  // 先对整条命令跑危险模式：`curl ... | sh` 这类跨管道组合必须整体识别。
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) {
      return { level: 'dangerous', reason: why };
    }
  }

  // 再按命令分隔符拆段：`type x & powershell -enc ...` 不能因为首段只读就整体放行。
  const segments = cmd.split(/\s*(?:&&|\|\||[&|;\n])\s*/).filter(Boolean);
  let worst: RiskVerdict = { level: 'safe', reason: '只读命令' };
  for (const segment of segments) {
    const verdict = classifyCommandSegment(segment, root);
    if (verdict.level === 'dangerous') {
      return verdict;
    }
    if (verdict.level === 'risky') {
      worst = verdict;
    }
  }
  return worst;
}

function classifyCommandSegment(cmd: string, root: string): RiskVerdict {
  if (!cmd) {
    return { level: 'safe', reason: '空命令' };
  }
  for (const { re, why } of DANGEROUS_PATTERNS) {
    if (re.test(cmd)) {
      return { level: 'dangerous', reason: why };
    }
  }
  // 绝对路径（C:/ 或 C:\）与 UNC（\\server\share）指向工作区之外 → 至少 risky
  const outside = [...cmd.matchAll(/(?:[a-z]:[\\/][^\s"']+|\\\\[^\s"']+)/gi)].map((m) => m[0]);
  if (root && outside.some((p) => !path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase()))) {
    return { level: 'risky', reason: '命令触及工作区之外的路径' };
  }
  if (/(^|[\s"'=])(?:\.\.|~)[\\/]/.test(cmd)) {
    return { level: 'risky', reason: '命令引用工作区外的相对路径' };
  }
  for (const { re, why } of RISKY_PATTERNS) {
    if (re.test(cmd)) {
      return { level: 'risky', reason: why };
    }
  }
  if (SAFE_COMMANDS.some((safe) => cmd === safe || cmd.startsWith(`${safe} `))) {
    return { level: 'safe', reason: '只读命令' };
  }
  return { level: 'risky', reason: '未知命令，按有副作用处理' };
}

/** 判断任意工具调用的风险等级。 */
export function classify(call: ToolCall, root: string): RiskVerdict {
  const { name, args } = call;
  if (READ_ONLY_TOOLS.has(name)) {
    return { level: 'safe', reason: '只读工具' };
  }
  if (name === 'run_terminal' || name === 'run_shell') {
    const command = typeof args.command === 'string' ? args.command : '';
    return classifyCommand(command, root);
  }
  if (name === 'write_file' || name === 'apply_patch') {
    const target = typeof args.path === 'string' ? args.path : '';
    const resolved = root ? path.resolve(root, target) : target;
    const inside = root ? resolved.toLowerCase().startsWith(path.resolve(root).toLowerCase()) : true;
    return {
      level: inside ? 'risky' : 'dangerous',
      reason: inside ? '写工作区内文件' : '写工作区之外的文件',
    };
  }
  return { level: 'risky', reason: `未知工具 ${name}` };
}

/** 只做判定、不弹窗：聊天路径用它决定是否需要人工确认。 */
export function decide(call: ToolCall, mode: PermissionMode, root: string): { needsConfirm: boolean; verdict: RiskVerdict } {
  const verdict = classify(call, root);
  if (mode === 'allow' || verdict.level === 'safe') {
    return { needsConfirm: false, verdict };
  }
  if (mode === 'risk' && verdict.level === 'risky') {
    return { needsConfirm: false, verdict };
  }
  return { needsConfirm: true, verdict };
}

/**
 * 按模式决定是否需要人工确认。
 * @param confirm 由调用方提供（VS Code 里是模态对话框）
 */
export async function gate(
  call: ToolCall,
  mode: PermissionMode,
  root: string,
  confirm: (call: ToolCall, verdict: RiskVerdict) => Promise<boolean>,
): Promise<GateResult & { verdict: RiskVerdict }> {
  const verdict = classify(call, root);
  if (mode === 'allow' || verdict.level === 'safe') {
    return { allowed: true, verdict };
  }
  if (mode === 'risk' && verdict.level === 'risky') {
    // 按需确认：低风险放行，高风险才问
    return { allowed: true, verdict };
  }
  const ok = await confirm(call, verdict);
  return {
    allowed: ok,
    verdict,
    deniedReason: ok ? undefined : `用户拒绝执行（风险等级：${verdict.level}，原因：${verdict.reason}）。`,
  };
}
