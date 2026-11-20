/**
 * Windows 终端输出编码兜底。
 *
 * cmd.exe / PowerShell 在中文系统上常输出 GBK（cp936），直接按 UTF-8 解码会变成
 * 「锟斤拷」；这里先尝试 UTF-8，发现替换字符再用 gb18030 解码。
 */
export function decodeConsoleBuffer(buffer: Buffer): string {
  if (!buffer || buffer.length === 0) {
    return '';
  }
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    return utf8;
  }
  if (buffer.includes(0)) {
    const utf16 = buffer.toString('utf16le');
    if (!utf16.includes('\uFFFD')) {
      return utf16.replace(/\u0000+$/g, '');
    }
  }
  for (const encoding of ['gb18030', 'gbk']) {
    try {
      const text = new TextDecoder(encoding, { fatal: false }).decode(buffer);
      if (text && !text.includes('\uFFFD')) {
        return text;
      }
    } catch {
      /* 当前 Node 不支持该编码时继续 */
    }
  }
  return utf8;
}
