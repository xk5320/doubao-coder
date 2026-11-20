/**
 * MCP 客户端管理器：把外部 MCP server 的工具接进扩展的 Agent。
 *
 * - 配置来自 doubao.mcp.servers（name/command/args/env/cwd/enabled/timeoutMs）
 * - 启动、握手、列工具、路由调用都由 mcp/client.ts 负责
 * - 这里只做生命周期、缓存与 ToolDefinition 适配，不碰 UI
 */
import type { ToolDefinition, ToolOutcome } from '../agent/tools';
import { log, warn } from '../log';
import {
  McpClientPool,
  type McpLogEvent,
  type McpServerConfig,
  type McpServerStatus,
  type McpToolInfo,
} from './client';

export interface McpStatusSnapshot {
  servers: McpServerStatus[];
  toolCount: number;
  tools: string[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toToolDefinition(tool: McpToolInfo): ToolDefinition {
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : { type: 'object', properties: {}, additionalProperties: true };
  const description = tool.description?.trim();
  return {
    name: tool.qualifiedName,
    description: `[MCP:${tool.server}] ${description || tool.name}`,
    parameters: schema as Record<string, unknown>,
  };
}

export class McpManager {
  private pool: McpClientPool | undefined;
  private definitions: ToolDefinition[] = [];
  private statuses: McpServerStatus[] = [];
  private generation = 0;
  private reloading: Promise<void> = Promise.resolve();
  private disposed = false;

  /** 当前的路由器；即使 MCP 还没启动也可以安全取用。 */
  public readonly router = {
    definitions: (): ToolDefinition[] => this.definitions.slice(),
    has: (name: string): boolean => this.definitions.some((tool) => tool.name === name),
    call: async (name: string, args: Record<string, unknown>): Promise<ToolOutcome> => this.callTool(name, args),
  };

  public get toolCount(): number {
    return this.definitions.length;
  }

  public get toolNames(): string[] {
    return this.definitions.map((tool) => tool.name);
  }

  public snapshot(): McpStatusSnapshot {
    return { servers: this.statuses.map((status) => ({ ...status })), toolCount: this.definitions.length, tools: this.toolNames };
  }

  /**
   * 重新加载 MCP 配置（配置变更或激活时调用）。
   * 串行执行；旧连接池总是先关闭。没有配置时只清空状态。
   */
  public reload(configs: McpServerConfig[]): Promise<void> {
    const run = this.reloading.then(() => this.doReload(configs));
    // 保持链不因单次失败而断掉
    this.reloading = run.catch(() => undefined);
    return run;
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.generation += 1;
    const pool = this.pool;
    this.pool = undefined;
    this.definitions = [];
    this.statuses = [];
    if (pool) {
      await pool.dispose().catch(() => undefined);
    }
    await this.reloading.catch(() => undefined);
  }

  private async doReload(configs: McpServerConfig[]): Promise<void> {
    if (this.disposed) {
      return;
    }
    const generation = ++this.generation;
    const previous = this.pool;
    this.pool = undefined;
    this.definitions = [];
    this.statuses = [];
    if (previous) {
      await previous.dispose().catch((err) => warn('关闭旧 MCP 连接池失败', errorMessage(err)));
    }

    const valid = (Array.isArray(configs) ? configs : []).filter(
      (config) => config && typeof config.name === 'string' && config.name.trim() && typeof config.command === 'string' && config.command.trim(),
    );
    if (valid.length === 0) {
      log('MCP：没有配置外部 server（doubao.mcp.servers 为空）');
      return;
    }

    const pool = new McpClientPool({ onLog: (event: McpLogEvent) => this.log(event) });
    this.pool = pool;
    log('MCP：启动', `${valid.length} 个 server`, valid.map((config) => config.name).join(', '));

    try {
      const statuses = await pool.start(valid);
      if (generation !== this.generation || this.disposed) {
        await pool.dispose().catch(() => undefined);
        return;
      }
      this.statuses = statuses;
      const tools = await pool.listTools();
      if (generation !== this.generation || this.disposed) {
        await pool.dispose().catch(() => undefined);
        return;
      }
      this.definitions = tools.map(toToolDefinition);
      const ok = statuses.filter((status) => status.ok).length;
      log('MCP：就绪', `server ${ok}/${statuses.length}`, `工具 ${tools.length} 个`);
      for (const status of statuses) {
        if (!status.ok) {
          warn('MCP：server 不可用', status.name, status.error ?? '');
        }
      }
    } catch (err) {
      if (generation === this.generation) {
        warn('MCP：启动失败', errorMessage(err));
      }
      await pool.dispose().catch(() => undefined);
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const pool = this.pool;
    if (!pool) {
      return { ok: false, content: `MCP 工具 ${name} 当前不可用（没有已连接的 server）。` };
    }
    try {
      const text = await pool.callTool(name, args);
      return { ok: true, content: text };
    } catch (err) {
      return { ok: false, content: `MCP 工具 ${name} 执行失败：${errorMessage(err)}` };
    }
  }

  private log(event: McpLogEvent): void {
    const line = `[${event.server}] ${event.message}`;
    if (event.level === 'error') {
      warn('MCP', line);
    } else if (event.level === 'warn') {
      warn('MCP', line);
    } else {
      log('MCP', line);
    }
  }
}
