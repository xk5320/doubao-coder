/**
 * 协议观测：直接订阅豆包页面的 WebSocket 帧，解出它自己的事件流。
 *
 * 实测帧格式（见 本机调试日志）：
 *   payload = 4 字符前缀（"CLip"/"CPSv"…） + base64(protobuf)
 *   protobuf 内是若干 string 字段（x_frontier_traceid / traceparent / "application/json"）
 *   以及一个大 string 字段，内容是 JSON：{"cmd":200,"downlink_body":{...}}
 *
 * 用法：命令「豆包: 抓取协议帧」启动 N 秒采集，结果写进日志与文件。
 * 这样界面不必再靠 DOM 猜「处理中」，而是能拿到和豆包自己同源的事件。
 */
import * as fs from 'fs';
import * as path from 'path';

import { CdpSession, DOUBAO_DEBUG_PORT, listTargets, pickChatPage } from './cdp';
import { log, warn } from '../log';

export interface ProtocolEvent {
  at: number;
  prefix: string;
  cmd?: number;
  body?: unknown;
  raw?: string;
}

/** 读 varint。 */
function readVarint(buf: Buffer, pos: number): [number, number] {
  let shift = 0;
  let value = 0;
  let index = pos;
  while (index < buf.length) {
    const byte = buf[index];
    index += 1;
    value |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) {
      return [value >>> 0, index];
    }
    shift += 7;
  }
  throw new Error('varint 越界');
}

/** 极简 protobuf 解析：只取 length-delimited 字段。 */
function parseLengthDelimited(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const [key, next] = readVarint(buf, pos);
    pos = next;
    const wire = key & 0x7;
    if (wire === 0) {
      const [, after] = readVarint(buf, pos);
      pos = after;
    } else if (wire === 1) {
      pos += 8;
    } else if (wire === 5) {
      pos += 4;
    } else if (wire === 2) {
      const [length, after] = readVarint(buf, pos);
      pos = after;
      out.push(buf.subarray(pos, pos + length));
      pos += length;
    } else {
      throw new Error(`未知 wire type ${wire}`);
    }
  }
  return out;
}

/** 从字段里挑出内嵌 JSON。 */
export function extractJson(blob: Buffer): unknown {
  const text = blob.toString('utf8');
  const start = text.indexOf('{"');
  if (start < 0) {
    return undefined;
  }
  for (let end = text.length; end > start; end -= 1) {
    const chunk = text.slice(start, end);
    try {
      return JSON.parse(chunk);
    } catch {
      /* 继续缩短 */
    }
  }
  return undefined;
}

/** 解一帧。返回 undefined 表示不是我们认识的帧。 */
export function decodeFrame(payload: string): { prefix: string; json?: Record<string, unknown> } | undefined {
  if (!payload || payload.length < 8) {
    return undefined;
  }
  const prefix = payload.slice(0, 4);
  let blob: Buffer;
  try {
    blob = Buffer.from(payload.slice(4), 'base64');
  } catch {
    return undefined;
  }
  let fields: Buffer[];
  try {
    fields = parseLengthDelimited(blob);
  } catch {
    return undefined;
  }
  for (const field of fields) {
    const json = extractJson(field);
    if (json && typeof json === 'object') {
      return { prefix, json: json as Record<string, unknown> };
    }
  }
  return { prefix };
}

/**
 * 采集 N 秒的协议帧。
 * @param options.seconds 采集时长
 * @param options.onEvent 每条解出的事件
 * @param options.saveTo 落盘路径（JSONL），可选
 */
export async function captureProtocol(options: {
  seconds?: number;
  port?: number;
  onEvent?: (event: ProtocolEvent) => void;
  saveTo?: string;
} = {}): Promise<ProtocolEvent[]> {
  const seconds = options.seconds ?? 30;
  const port = options.port ?? DOUBAO_DEBUG_PORT;
  const targets = await listTargets(port);
  const page = await pickChatPage(targets);
  if (!page) {
    throw new Error('没有找到豆包页面（需要以调试端口启动）');
  }
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  const events: ProtocolEvent[] = [];
  const stream = options.saveTo ? fs.createWriteStream(options.saveTo, { flags: 'a' }) : undefined;
  try {
    await session.send('Network.enable', { maxTotalBufferSize: 200 * 1024 * 1024 });
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const batch = await session.takeEvents(250);
      for (const evt of batch) {
        if (evt.method !== 'Network.webSocketFrameReceived') {
          continue;
        }
        const payload = (evt.params as { response?: { payloadData?: string } })?.response?.payloadData;
        if (typeof payload !== 'string') {
          continue;
        }
        const decoded = decodeFrame(payload);
        const event: ProtocolEvent = {
          at: Date.now(),
          prefix: decoded?.prefix ?? '',
          cmd: typeof decoded?.json?.cmd === 'number' ? (decoded.json.cmd as number) : undefined,
          body: decoded?.json,
        };
        events.push(event);
        options.onEvent?.(event);
        if (stream) {
          stream.write(`${JSON.stringify(event)}\n`);
        }
      }
    }
  } finally {
    stream?.end();
    session.close();
  }
  log('协议采集完成', `${events.length} 帧`);
  return events;
}

/** 默认落盘路径：<扩展目录>/调试输出/日志-<time>.jsonl */
export function defaultCapturePath(root: string): string {
  const dir = path.join(root, 'artifacts');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    warn('创建 artifacts 目录失败', err instanceof Error ? err.message : String(err));
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `protocol-${stamp}.jsonl`);
}
