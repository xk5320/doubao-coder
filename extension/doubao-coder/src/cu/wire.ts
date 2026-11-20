/**
 * GAC 线协议移植（对照 `gac_runtime/wire.py`、`transport/protocol.py`）
 *
 * 豆包桌面端的 Computer Use 不是"直接调 Win32"，而是：
 *   Python API → GAC 命令 envelope → named pipe(ChaCha20-Poly1305 帧) → 宿主执行
 *
 * 本文件移植**帧 + 命令 envelope** 两层的编解码（纯函数，可离线单测）。
 * 说明：我们不复用它的加密通道（那需要宿主进程的 secret），只对齐位序与语义，
 * 这样上层 envelope/渲染/cell 记账可以与原实现一一对应。
 *
 * 关键位序（原实现处处小端，只有 PNG IHDR 宽高大端）：
 *   帧:      "GACF" | u32 LE size | payload
 *   命令:    u8 version | u8 module_id | u32 LE command_id | u32 LE payload_len | payload(JSON utf8)
 *   响应:    u8 status | u32 LE payload_len | payload
 */

export const FRAME_MAGIC = Buffer.from('GACF', 'ascii');
export const MAX_FRAME_SIZE = 128 * 1024 * 1024;
export const MAX_PLAINTEXT_SIZE = MAX_FRAME_SIZE - 28; // nonce(12) + tag(16)
export const MAX_HANDSHAKE_FRAME = 4096;

/** 模块 ID（原实现：1=Browser、2=WindowsCU、4=AX） */
export const ModuleId = { browser: 1, computerUseWindows: 2, computerUseAx: 4 } as const;

/** 命令号（`modules/computer_use_windows.py:143-328`） */
export const Command = {
  ListApps: 1,
  LaunchApp: 2,
  Screenshot: 3,
  Click: 5,
  Hover: 6,
  Drag: 7,
  Scroll: 8,
  Type: 9,
  Hotkey: 10,
  Wait: 11,
  GetClipboard: 12,
  SetClipboard: 13,
  Press: 14,
  KeyDown: 15,
  KeyUp: 16,
  CopySelection: 17,
  SwitchDesktop: 18,
} as const;

export type CommandId = (typeof Command)[keyof typeof Command];

export interface GacFrame {
  payload: Buffer;
}

export interface GacCommand {
  version: number;
  moduleId: number;
  commandId: number;
  /** 已解析的 JSON 参数。 */
  params: Record<string, unknown>;
  /** 原始 JSON 文本（用于断言序列化风格：ensure_ascii=False / 紧凑分隔符）。 */
  rawJson?: string;
}

export interface GacResponse {
  status: number;
  /** JSON 载荷；截图命令额外带二进制，用 decodeScreenshotResponse 解析。 */
  payload: Buffer;
}

export class WireError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

/** 打包一帧（明文；原实现的密文帧只是把 payload 换成 nonce|ciphertext|tag）。 */
export function encodeFrame(payload: Buffer): Buffer {
  if (payload.length > MAX_PLAINTEXT_SIZE) {
    throw new WireError(`帧过大：${payload.length} > ${MAX_PLAINTEXT_SIZE}`, 'WIRE_FRAME_TOO_LARGE');
  }
  const header = Buffer.alloc(8);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** 解一帧；数据不足返回 undefined（流式场景），格式错误抛 WireError。 */
export function decodeFrame(buffer: Buffer): { frame: GacFrame; rest: Buffer } | undefined {
  if (buffer.length < 8) {
    return undefined;
  }
  if (!buffer.subarray(0, 4).equals(FRAME_MAGIC)) {
    throw new WireError('帧魔数不对（期望 GACF）', 'WIRE_BAD_MAGIC');
  }
  const size = buffer.readUInt32LE(4);
  if (size > MAX_FRAME_SIZE) {
    throw new WireError(`帧长度非法：${size}`, 'WIRE_BAD_SIZE');
  }
  if (buffer.length < 8 + size) {
    return undefined;
  }
  return { frame: { payload: buffer.subarray(8, 8 + size) }, rest: buffer.subarray(8 + size) };
}

/** 命令 envelope 编码。JSON 用紧凑分隔符（对齐原实现的 separators=(",",":")）。 */
export function encodeCommand(moduleId: number, commandId: CommandId, params: Record<string, unknown>): Buffer {
  const json = JSON.stringify(params);
  const body = Buffer.from(json, 'utf8');
  const head = Buffer.alloc(10);
  head.writeUInt8(1, 0); // protocol_version
  head.writeUInt8(moduleId, 1);
  head.writeUInt32LE(commandId, 2);
  head.writeUInt32LE(body.length, 6);
  return Buffer.concat([head, body]);
}

/** 命令 envelope 解码（用于测试与非加密通道）。 */
export function decodeCommand(buffer: Buffer): GacCommand {
  if (buffer.length < 10) {
    throw new WireError('命令头不足 10 字节', 'WIRE_SHORT_COMMAND');
  }
  const version = buffer.readUInt8(0);
  const moduleId = buffer.readUInt8(1);
  const commandId = buffer.readUInt32LE(2);
  const len = buffer.readUInt32LE(6);
  if (buffer.length < 10 + len) {
    throw new WireError('命令载荷不足', 'WIRE_SHORT_PAYLOAD');
  }
  const rawJson = buffer.subarray(10, 10 + len).toString('utf8');
  let params: Record<string, unknown> = {};
  if (len > 0) {
    try {
      params = JSON.parse(rawJson) as Record<string, unknown>;
    } catch {
      throw new WireError('命令载荷不是合法 JSON', 'WIRE_BAD_JSON');
    }
  }
  return { version, moduleId, commandId, params, rawJson };
}

/** 响应编码：u8 status | u32 LE len | payload。 */
export function encodeResponse(status: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(status, 0);
  head.writeUInt32LE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export function decodeResponse(buffer: Buffer): GacResponse {
  if (buffer.length < 5) {
    throw new WireError('响应头不足 5 字节', 'WIRE_SHORT_RESPONSE');
  }
  const status = buffer.readUInt8(0);
  const len = buffer.readUInt32LE(1);
  if (buffer.length < 5 + len) {
    throw new WireError('响应载荷不足', 'WIRE_SHORT_PAYLOAD');
  }
  if (buffer.length > 5 + len) {
    // 原实现：尾部多余字节 → protocol error
    throw new WireError(`响应尾部多余 ${buffer.length - 5 - len} 字节`, 'WIRE_EXCESS_DATA');
  }
  return { status, payload: buffer.subarray(5, 5 + len) };
}

/**
 * 截图响应：JSON param 之后接 `u32 w | u32 h | u32 png_size | png`，
 * 且 JSON 里的宽高与二进制头**互相校验**（`computer_use_windows.py:347-388`）。
 */
export function decodeScreenshotResponse(response: GacResponse): {
  params: Record<string, unknown>;
  width: number;
  height: number;
  png: Buffer;
} {
  const buf = response.payload;
  // 找到 JSON 边界：原实现先读长度前缀，这里用"首个 { 到配对的 }"来定位
  if (buf.length < 1 || buf[0] !== 0x7b /* { */) {
    throw new WireError('截图响应缺少 JSON 头', 'WIRE_BAD_SCREENSHOT');
  }
  let depth = 0;
  let end = -1;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0x7b) {
      depth += 1;
    } else if (buf[i] === 0x7d) {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new WireError('截图响应 JSON 未闭合', 'WIRE_BAD_SCREENSHOT');
  }
  let params: Record<string, unknown> = {};
  try {
    params = JSON.parse(buf.subarray(0, end + 1).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new WireError('截图响应 JSON 解析失败', 'WIRE_BAD_SCREENSHOT');
  }
  const bin = buf.subarray(end + 1);
  if (bin.length < 12) {
    throw new WireError('截图二进制头不足', 'WIRE_BAD_SCREENSHOT');
  }
  const width = bin.readUInt32LE(0);
  const height = bin.readUInt32LE(4);
  const size = bin.readUInt32LE(8);
  const png = bin.subarray(12, 12 + size);
  if (png.length !== size) {
    throw new WireError('截图 PNG 长度不符', 'WIRE_BAD_SCREENSHOT');
  }
  // 双份尺寸校验
  const jsonW = Number(params.width ?? width);
  const jsonH = Number(params.height ?? height);
  if (jsonW !== width || jsonH !== height) {
    throw new WireError(`截图尺寸不一致：json=${jsonW}x${jsonH} bin=${width}x${height}`, 'WIRE_SCREENSHOT_SIZE_MISMATCH');
  }
  // PNG 魔数与 IHDR（宽高大端）
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new WireError('不是合法 PNG', 'WIRE_BAD_PNG');
  }
  const ihdrW = png.readUInt32BE(16);
  const ihdrH = png.readUInt32BE(20);
  if (ihdrW !== width || ihdrH !== height) {
    throw new WireError(`PNG IHDR ${ihdrW}x${ihdrH} 与头部 ${width}x${height} 不一致`, 'WIRE_PNG_SIZE_MISMATCH');
  }
  return { params, width, height, png };
}

/** 构造截图响应（测试/后端用）。 */
export function encodeScreenshotResponse(width: number, height: number, png: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify({ width, height }), 'utf8');
  const head = Buffer.alloc(12);
  head.writeUInt32LE(width, 0);
  head.writeUInt32LE(height, 4);
  head.writeUInt32LE(png.length, 8);
  return encodeResponse(0, Buffer.concat([json, head, png]));
}
