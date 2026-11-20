/** 读取当前工作区未提交的 git 改动（用于上下文）。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitDiffResult {
  ok: boolean;
  text: string;
  error?: string;
}

export async function readGitDiff(cwd: string, limit = 12000): Promise<GitDiffResult> {
  if (!cwd) {
    return { ok: false, text: '', error: '没有打开工作区' };
  }
  try {
    const stat = await run('git', ['diff', '--stat'], { cwd, maxBuffer: 4 * 1024 * 1024 });
    const patch = await run('git', ['diff', '--unified=1'], { cwd, maxBuffer: 8 * 1024 * 1024 });
    const text = String(stat.stdout || '') + '\n' + String(patch.stdout || '');
    if (!text.trim()) {
      return { ok: true, text: '（工作区没有未提交的改动）' };
    }
    return { ok: true, text: text.length > limit ? text.slice(0, limit) + '\n…（已截断）' : text };
  } catch (err) {
    return { ok: false, text: '', error: err instanceof Error ? err.message : String(err) };
  }
}