/**
 * 极简 WebSocket 客户端（仅客户端方向，够连 Chrome DevTools Protocol 用）。
 *
 * 之所以不引第三方依赖：扩展用纯 tsc 构建、不分包，引入 `ws` 会让 node_modules 进入
 * 发布产物；CDP 只需要「文本帧 + 分片 + ping/pong」这几个特性，自己实现约 150 行更稳。
 */
import * as net from 'node:net';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

export interface ParsedWsUrl {
  host: string;
  port: number;
  path: string;
}

export function parseWsUrl(url: string): ParsedWsUrl {
  const match = /^ws:\/\/([^/:]+)(?::(\d+))?(\/.*)?$/i.exec(url.trim());
  if (!match) {
    throw new Error(`不是合法的 ws:// 地址：${url}`);
  }
  return {
    host: match[1],
    port: match[2] ? Number(match[2]) : 80,
    path: match[3] ?? '/',
  };
}

export class MiniWebSocket extends EventEmitter {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private handshaken = false;
  private closed = false;
  private pingTimer?: NodeJS.Timeout;

  private constructor(socket: net.Socket) {
    super();
    this.socket = socket;
  }

  /** 建立连接并完成 HTTP Upgrade 握手。 */
  public static connect(url: string, timeoutMs = 5000): Promise<MiniWebSocket> {
    const { host, port, path } = parseWsUrl(url);
    return new Promise<MiniWebSocket>((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const key = crypto.randomBytes(16).toString('base64');
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error(`连接 ${host}:${port} 超时`)), timeoutMs);

      socket.once('error', (err) => fail(err));
      socket.once('connect', () => {
        // 注意：不发 Origin —— CDP 默认只接受无 Origin 或白名单内的来源。
        socket.write(
          [
            `GET ${path} HTTP/1.1`,
            `Host: ${host}:${port}`,
            'Upgrade: websocket',
            'Connection: Upgrade',
            `Sec-WebSocket-Key: ${key}`,
            'Sec-WebSocket-Version: 13',
            '',
            '',
          ].join('\r\n'),
        );
      });

      const onHandshakeData = (chunk: Buffer): void => {
        const text = chunk.toString('latin1');
        const end = text.indexOf('\r\n\r\n');
        if (end < 0) {
          return;
        }
        socket.removeListener('data', onHandshakeData);
        const head = text.slice(0, end);
        if (!/^HTTP\/1\.1 101/i.test(head)) {
          fail(new Error(`WebSocket 握手失败：${head.split('\r\n')[0] ?? head}`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        const ws = new MiniWebSocket(socket);
        ws.handshaken = true;
        ws.attach();
        const rest = chunk.subarray(Buffer.byteLength(text.slice(0, end + 4), 'latin1'));
        if (rest.length > 0) {
          ws.onData(rest);
        }
        resolve(ws);
      };
      socket.on('data', onHandshakeData);
    });
  }

  private attach(): void {
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      this.closed = true;
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
      }
      this.emit('close');
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      for (;;) {
        const frame = this.readFrame();
        if (!frame) {
          return;
        }
        this.handleFrame(frame);
      }
    } catch (err) {
      // socket 'data' 回调里抛错会变成 EventEmitter 未捕获异常，直接打挂扩展宿主。
      this.buffer = Buffer.alloc(0);
      if (this.listenerCount('error') > 0) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
      this.close();
    }
  }

  private readFrame(): { fin: boolean; opcode: number; payload: Buffer } | undefined {
    const buf = this.buffer;
    if (buf.length < 2) {
      return undefined;
    }
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) {
        return undefined;
      }
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) {
        return undefined;
      }
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(64 * 1024 * 1024)) {
        throw new Error('WebSocket 帧过大，已断开');
      }
      len = Number(big);
      offset = 10;
    }
    let maskKey: Buffer | undefined;
    if (masked) {
      if (buf.length < offset + 4) {
        return undefined;
      }
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) {
      return undefined;
    }
    let payload = buf.subarray(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    this.buffer = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  private handleFrame(frame: { fin: boolean; opcode: number; payload: Buffer }): void {
    const { fin, opcode, payload } = frame;
    if (opcode === OP_PING) {
      this.writeFrame(OP_PONG, payload);
      return;
    }
    if (opcode === OP_PONG || opcode === OP_CLOSE) {
      if (opcode === OP_CLOSE) {
        this.close();
      }
      return;
    }
    if (opcode === OP_TEXT || opcode === OP_BINARY) {
      if (this.fragments.length > 0) {
        this.fragments = [];
      }
      this.fragmentOpcode = opcode;
      this.fragments.push(payload);
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      return;
    }
    if (!fin) {
      return;
    }
    const full = Buffer.concat(this.fragments);
    const isText = this.fragmentOpcode === OP_TEXT;
    this.fragments = [];
    if (isText) {
      this.emit('message', full.toString('utf8'));
    } else {
      this.emit('binary', full);
    }
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.closed || !this.socket.writable) {
      return;
    }
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) {
      masked[i] ^= mask[i % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  public get ready(): boolean {
    return this.handshaken && !this.closed;
  }

  public send(text: string): void {
    this.writeFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
    }
    try {
      this.writeFrame(OP_CLOSE, Buffer.alloc(0));
      this.socket.end();
    } catch {
      /* ignore */
    }
  }
}
