/**
 * 把 Markdown 里的本地图片路径换成 data URL。
 *
 * 关键点：Windows 路径里经常带空格和括号（如 `英雄-铁骑 (SR) .png`），
 * 不能用 `[^)]+` 截断，必须做括号配对扫描。
 */

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export type ImagePathReader = (path: string) => string | undefined;

/** 从 Markdown 链接目标里取出本地路径；http/data 或无法识别返回 undefined。 */
export function localImagePath(raw: string): string | undefined {
  let src = String(raw || '').trim();
  if (src.startsWith('<') && src.endsWith('>')) {
    src = src.slice(1, -1).trim();
  }
  src = src.replace(/^["']|["']$/g, '').trim();
  if (!src || /^(data:|https?:)/i.test(src)) {
    return undefined;
  }
  if (/^file:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      let p = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(p)) {
        p = p.slice(1);
      }
      return p;
    } catch {
      return undefined;
    }
  }
  if (/^[A-Za-z]:[\\/]/.test(src)) {
    return src;
  }
  return undefined;
}

/** 用自定义读取器替换文本中的本地图片；保留无法读取的原始 Markdown。 */
export function convertLocalImages(text: string, read: ImagePathReader): string {
  const source = String(text || '');
  let out = '';
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf('![', i);
    if (start < 0) {
      out += source.slice(i);
      break;
    }
    const mid = source.indexOf('](', start + 2);
    if (mid < 0) {
      out += source.slice(i);
      break;
    }
    // 从 "![alt](" 之后开始做括号配对，允许路径里出现 (R) / (SR)
    let depth = 1;
    let j = mid + 2;
    for (; j < source.length; j += 1) {
      const ch = source[j];
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    if (depth !== 0) {
      out += source.slice(i);
      break;
    }
    const alt = source.slice(start + 2, mid);
    const target = source.slice(mid + 2, j);
    const path = localImagePath(target);
    const plain = String(target || '').trim().replace(/^<|>$/g, '').replace(/^["']|["']$/g, '');
    const looksImage = /\.(png|jpe?g|gif|webp|bmp|svg)([?#].*)?$/i.test(plain) && !/^(data:|https?:|blob:|file:)/i.test(plain);
    const data = path ? read(path) : looksImage ? read(plain) : undefined;
    out += source.slice(i, start) + (data ? `![${alt}](${data})` : source.slice(start, j + 1));
    i = j + 1;
  }
  return out;
}

export function mimeForImage(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return MIME[ext];
}
