#!/usr/bin/env node
'use strict';

/**
 * 测试用 MCP stdio server（零依赖）。
 *
 * 支持的方法：
 *   initialize、notifications/initialized、tools/list（两页 cursor 分页）、
 *   tools/call（echo / fail / crash）、ping。
 *
 * 命令行开关：
 *   --exit-on-start  启动后立即以退出码 2 退出（模拟启动失败）
 *   --garbage        启动时先输出一行非法 JSON 再正常工作
 *   --fragment       所有响应拆成两次 write（模拟半行）
 *   --sticky         响应后紧跟一条 notification，一次 write（模拟粘包）
 */
const readline = require('node:readline');

const FLAGS = new Set(process.argv.slice(2));
const EXIT_ON_START = FLAGS.has('--exit-on-start');
const GARBAGE = FLAGS.has('--garbage');
const FRAGMENT = FLAGS.has('--fragment');
const STICKY = FLAGS.has('--sticky');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'mock-mcp-server';
const SERVER_VERSION = '0.1.0';

const PAGE_ONE = [
  {
    name: 'echo',
    description: '原样返回入参（JSON 文本）',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '任意消息' },
        count: { type: 'number', description: '任意数字' },
      },
      additionalProperties: true,
    },
  },
];

const PAGE_TWO = [
  {
    name: 'fail',
    description: '总是返回 isError:true，用于测试工具报错',
    inputSchema: {
      type: 'object',
      properties: { reason: { type: 'string' } },
      additionalProperties: true,
    },
  },
  {
    name: 'crash',
    description: '让 mock server 直接退出，用于测试 pending 被拒绝',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  },
];

function writeRaw(text) {
  if (!text) {
    return;
  }
  if (FRAGMENT) {
    let middle = Math.floor(text.length / 2);
    const code = text.charCodeAt(middle);
    if (code >= 0xdc00 && code <= 0xdfff) {
      middle -= 1;
    }
    process.stdout.write(text.slice(0, middle));
    setTimeout(() => {
      process.stdout.write(text.slice(middle));
    }, 5);
    return;
  }
  if (STICKY) {
    const extra =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'debug', data: 'sticky-followup' },
      }) + '\n';
    process.stdout.write(text + extra);
    return;
  }
  process.stdout.write(text);
}

function send(payload) {
  writeRaw(JSON.stringify(payload) + '\n');
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id: id, result: result });
}

function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } });
}

function handleToolsList(id, params) {
  const cursor = params && typeof params.cursor === 'string' ? params.cursor : '';
  if (!cursor) {
    sendResult(id, { tools: PAGE_ONE, nextCursor: 'page-2' });
    return;
  }
  if (cursor === 'page-2') {
    sendResult(id, { tools: PAGE_TWO });
    return;
  }
  sendResult(id, { tools: [] });
}

function handleToolsCall(id, params) {
  const name = params && typeof params.name === 'string' ? params.name : '';
  const args = params && typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
  if (name === 'echo') {
    sendResult(id, { content: [{ type: 'text', text: JSON.stringify(args) }], isError: false });
    return;
  }
  if (name === 'fail') {
    sendResult(id, {
      content: [{ type: 'text', text: '工具执行失败：这是 mock server 故意返回的错误' }],
      isError: true,
    });
    return;
  }
  if (name === 'crash') {
    process.stderr.write('[mock-mcp] crash 工具触发，退出码 3\n');
    process.exit(3);
    return;
  }
  sendError(id, -32602, '未知工具：' + name);
}

function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch (err) {
    sendError(null, -32700, 'JSON 解析失败');
    return;
  }
  if (!message || typeof message !== 'object') {
    sendError(null, -32600, '无效的 JSON-RPC 请求');
    return;
  }
  const hasId = typeof message.id === 'number' || typeof message.id === 'string';
  const id = hasId ? message.id : null;
  const params = message.params;

  switch (message.method) {
    case 'initialize':
      if (hasId) {
        sendResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: '测试用 mock MCP server',
        });
      }
      return;
    case 'notifications/initialized':
      return;
    case 'ping':
      if (hasId) {
        sendResult(id, {});
      }
      return;
    case 'tools/list':
      if (hasId) {
        handleToolsList(id, params);
      }
      return;
    case 'tools/call':
      if (hasId) {
        handleToolsCall(id, params);
      }
      return;
    default:
      if (hasId) {
        sendError(id, -32601, '不支持的方法：' + String(message.method));
      }
      return;
  }
}

if (EXIT_ON_START) {
  process.stderr.write('[mock-mcp] 模拟启动失败，退出码 2\n');
  process.exit(2);
}

process.stderr.write('[mock-mcp] 启动，argv=' + process.argv.slice(2).join(',') + '\n');

if (GARBAGE) {
  // 故意输出一行非法 JSON：客户端应记日志后继续工作。
  process.stdout.write('{ this is not valid json }\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', handleLine);
rl.on('close', () => {
  process.exit(0);
});
