import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { LoadedConfig } from "./config.js";
import { ConnectionManager } from "./connections/manager.js";
import { diag, type Logger } from "./logging.js";
import { toolDefinitions } from "./tools/index.js";
import type { ConnectionManageCapability, ToolContext } from "./tools/types.js";
import { VERSION } from "./version.js";

/**
 * 创建一个 MCP server，注册全部工具（stdio 与 HTTP 传输共用同一份注册逻辑）。
 * `user` 为该 server 实例绑定的调用者身份：stdio 为 "local"，HTTP 为 API Key 名称。
 * `manage` 为可选的连接管理能力：HTTP 模式注入，stdio 模式不注入（连接管理工具只读）。
 */
export function createMcpServer(
  config: LoadedConfig,
  logger: Logger,
  user: string,
  connections: ConnectionManager,
  manage?: ConnectionManageCapability,
  publicBaseUrl?: string,
): McpServer {
  const server = new McpServer({ name: "infinmcp", version: VERSION });

  for (const def of toolDefinitions) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
      },
      async (args: unknown) => {
        const started = Date.now();
        const ctx: ToolContext = {
          config,
          logger,
          connections,
          user,
          ...(publicBaseUrl ? { publicBaseUrl } : {}),
          manage,
        };
        try {
          const result = await def.handler((args ?? {}) as Record<string, unknown>, ctx);
          logger.record({
            user,
            tool: def.name,
            connection: result.connection,
            status: "ok",
            durationMs: Date.now() - started,
            rowCount: result.rowCount,
            summary: result.summary,
          });
          const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: result.text }];
          return result.structured === undefined
            ? { content }
            : { content, structuredContent: result.structured };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.record({
            user,
            tool: def.name,
            status: "error",
            durationMs: Date.now() - started,
            error: message,
          });
          const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: `错误: ${message}` }];
          return { content, isError: true };
        }
      },
    );
  }

  return server;
}

/** 以 stdio 传输启动 MCP server（本地调试用）。 */
export async function runStdio(config: LoadedConfig, logger: Logger): Promise<void> {
  const connections = new ConnectionManager({
    connections: config.connections,
    timeoutMs: config.limits.timeoutMs,
  });
  const server = createMcpServer(config, logger, "local", connections);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    diag("info", `收到 ${signal}，正在关闭连接…`);
    await connections.closeAll();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(transport);
  diag(
    "info",
    `stdio MCP server 已启动（user=local，工具 ${toolDefinitions.length} 个，连接 ${Object.keys(config.connections).length} 个）`,
  );
}
