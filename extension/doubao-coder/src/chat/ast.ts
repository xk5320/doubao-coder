/**
 * 把豆包回复的 Markdown 切成「有类型的块」，供 webview 用组件渲染。
 *
 * 之前是「按行切、只有 text/code/status」三种，表格会被压平、标题变小字。
 * 这里识别：heading / list / table / code / status / paragraph。
 */
export type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: Array<{ level: number; text: string }> }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; text: string; lang?: string; isCommand?: boolean }
  | { kind: 'status'; text: string };

const STATUS_RE = /^(已处理\s*\d+\s*秒|第\s*\d+\s*步|正在执行|正在处理)/;
const COMMAND_RE = /^(<\/>|已执行代码|正在执行代码)\s*/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UL_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?[\s:|-]+\|[\s:|-]*$/;

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

export function parseMarkdownBlocks(markdown: string): MdBlock[] {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  const pushParagraph = (buffer: string[]): void => {
    const text = buffer.join('\n').trim();
    if (text) {
      blocks.push({ kind: 'paragraph', text });
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    // 代码围栏
    const fence = /^```(\w*)\s*$/.exec(trimmed);
    if (fence) {
      const lang = fence[1] || undefined;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      blocks.push({ kind: 'code', text: body.join('\n'), lang });
      continue;
    }

    // 状态行 / 已执行代码
    if (STATUS_RE.test(trimmed)) {
      blocks.push({ kind: 'status', text: trimmed });
      i += 1;
      continue;
    }
    const cmd = COMMAND_RE.exec(trimmed);
    if (cmd) {
      blocks.push({ kind: 'code', text: trimmed.slice(cmd[1].length).trim(), isCommand: true });
      i += 1;
      continue;
    }

    // 标题
    const heading = HEADING_RE.exec(trimmed);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() });
      i += 1;
      continue;
    }

    // 表格：表头行 + 分隔行
    if (trimmed.includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const head = splitRow(trimmed);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    // 列表（连续的同类）
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      const ordered = Boolean(ol);
      const items: Array<{ level: number; text: string }> = [];
      while (i < lines.length) {
        const cur = lines[i];
        const mu = UL_RE.exec(cur);
        const mo = OL_RE.exec(cur);
        if (mu && !ordered === true) {
          items.push({ level: Math.floor(mu[1].length / 2), text: mu[2].trim() });
          i += 1;
          continue;
        }
        if (mo && ordered) {
          items.push({ level: Math.floor(mo[1].length / 2), text: mo[3].trim() });
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }

    // 普通段落：吃到空行或下一种块的起点
    const buffer: string[] = [];
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (!curTrim) {
        i += 1;
        break;
      }
      if (
        /^```/.test(curTrim) ||
        HEADING_RE.test(curTrim) ||
        UL_RE.test(cur) ||
        OL_RE.test(cur) ||
        STATUS_RE.test(curTrim) ||
        COMMAND_RE.test(curTrim)
      ) {
        break;
      }
      buffer.push(curTrim);
      i += 1;
    }
    pushParagraph(buffer);
  }

  return blocks;
}
