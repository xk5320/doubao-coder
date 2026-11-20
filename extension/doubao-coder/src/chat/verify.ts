/** 构建/测试验证：检测命令、执行并回填输出。 */
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type VerifyKind = 'build' | 'test';

export interface VerifyResult {
  ok: boolean;
  code: number | null;
  command: string;
  output: string;
  error?: string;
}

export function detectVerifyCommand(root: string, kind: VerifyKind): string {
  if (!root) {
    return '';
  }
  try {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts || {};
      const key = kind === 'build' ? 'build' : 'test';
      if (scripts[key]) {
        return 'npm run ' + key;
      }
    }
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
      return kind === 'build' ? 'cargo build' : 'cargo test';
    }
    if (fs.existsSync(path.join(root, 'CMakeCache.txt'))) {
      return 'cmake --build . --config Release';
    }
    if (fs.existsSync(path.join(root, 'build', 'CMakeCache.txt'))) {
      return 'cmake --build build --config Release';
    }
  } catch {
    return '';
  }
  return '';
}

export function runVerify(root: string, kind: VerifyKind, override = ''): Promise<VerifyResult> {
  const command = override || detectVerifyCommand(root, kind);
  if (!command) {
    return Promise.resolve({ ok: false, code: null, command: '', output: '', error: '没有检测到可用的构建/测试命令，可在设置里配置 doubao.verify.buildCommand / testCommand。' });
  }
  return new Promise((resolve) => {
    exec(command, { cwd: root, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const output = String(stdout || '') + String(stderr || '');
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code?: number }).code! : err ? 1 : 0;
      resolve({
        ok: !err,
        code,
        command,
        output: output.length > 20000 ? output.slice(0, 20000) + '\n…（已截断）' : output,
        error: err ? err.message : undefined,
      });
    });
  });
}