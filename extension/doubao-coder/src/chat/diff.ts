/** 行级 diff：把 before/after 拆成可单独接受的块（hunk）。 */

export interface DiffHunk {
  /** 在 before 里的起始行（0 基）。 */
  oldStart: number;
  oldLines: string[];
  newLines: string[];
}

const MAX_LINES = 2500;

function splitLines(text: string): string[] {
  return String(text ?? '').split('\n');
}

/** LCS 逐行 diff；文件过大时退化为“整文件一个块”。 */
export function computeHunks(before: string, after: string): DiffHunk[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.join('\n') === b.join('\n')) {
    return [];
  }
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [{ oldStart: 0, oldLines: a, newLines: b }];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const hunks: DiffHunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const start = i;
    const oldLines: string[] = [];
    const newLines: string[] = [];
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        break;
      }
      if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
        newLines.push(b[j]);
        j += 1;
      } else if (i < n) {
        oldLines.push(a[i]);
        i += 1;
      } else {
        break;
      }
    }
    hunks.push({ oldStart: start, oldLines, newLines });
  }
  return hunks;
}

/** 用选中的 hunk 应用改动，返回新文件内容。 */
export function applyHunks(before: string, hunks: DiffHunk[], accepted: number[]): string {
  const a = splitLines(before);
  const acceptedSet = new Set(accepted);
  const ordered = hunks.slice().sort((x, y) => x.oldStart - y.oldStart);
  const out: string[] = [];
  let cursor = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const hunk = ordered[index];
    while (cursor < hunk.oldStart && cursor < a.length) {
      out.push(a[cursor]);
      cursor += 1;
    }
    if (acceptedSet.has(index)) {
      out.push(...hunk.newLines);
    } else {
      out.push(...hunk.oldLines);
    }
    cursor = hunk.oldStart + hunk.oldLines.length;
  }
  while (cursor < a.length) {
    out.push(a[cursor]);
    cursor += 1;
  }
  return out.join('\n');
}
