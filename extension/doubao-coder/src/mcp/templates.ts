/** 常用 MCP server 模板：一键写入 doubao.mcp.servers。 */
import type { McpServerConfig } from './client';

export interface McpTemplate {
  id: string;
  name: string;
  description: string;
  build: (root: string) => McpServerConfig;
}

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: 'filesystem',
    name: '文件系统',
    description: '读写工作区文件（@modelcontextprotocol/server-filesystem）',
    build: (root) => ({ name: 'filesystem', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', root] }),
  },
  {
    id: 'git',
    name: 'Git',
    description: '查看/操作 Git 仓库（mcp-server-git）',
    build: (root) => ({ name: 'git', command: 'npx', args: ['-y', 'mcp-server-git', '--repository', root] }),
  },
  {
    id: 'fetch',
    name: '网页抓取',
    description: '抓取并转 Markdown（mcp-server-fetch）',
    build: () => ({ name: 'fetch', command: 'npx', args: ['-y', 'mcp-server-fetch'] }),
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: '查询 SQLite 数据库（mcp-server-sqlite，默认 data.db）',
    build: (root) => ({ name: 'sqlite', command: 'npx', args: ['-y', 'mcp-server-sqlite', '--db-path', 'data.db'], cwd: root }),
  },
];

/** 合并模板：同名替换，其它保留；非法项丢弃。 */
export function mergeMcpTemplate(existing: unknown, server: McpServerConfig): McpServerConfig[] {
  const list: McpServerConfig[] = Array.isArray(existing)
    ? (existing as unknown[])
        .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
        .map((item) => ({
          name: String(item.name || '').trim(),
          command: String(item.command || '').trim(),
          args: Array.isArray(item.args) ? item.args.map((arg) => String(arg)) : undefined,
        }))
        .filter((item) => item.name && item.command)
    : [];
  const next = list.filter((item) => item.name !== server.name);
  next.push(server);
  return next;
}
