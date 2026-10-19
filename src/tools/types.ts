import type { z } from "zod";
import type { LoadedConfig } from "../config.js";
import type { ConnectionManager } from "../connections/manager.js";
import type { Logger } from "../logging.js";

/** 工具执行上下文：由 server 层注入。 */
export interface ToolContext {
  config: LoadedConfig;
  logger: Logger;
  /** 连接管理器（按连接名懒加载驱动句柄）。 */
  connections: ConnectionManager;
  /** 调用者身份：API Key 名称；stdio 模式下为 "local"。 */
  user: string;
}

/** 工具执行结果。 */
export interface ToolResult {
  /** 返回给模型的文本。 */
  text: string;
  /** 可选的结构化结果（会作为 structuredContent 返回）。 */
  structured?: Record<string, unknown>;
  /** 日志用：目标连接名。 */
  connection?: string;
  /** 日志用：结果行数。 */
  rowCount?: number;
  /** 日志用：请求摘要（不含口令等敏感信息）。 */
  summary?: string;
}

/** 一个可注册的 MCP 工具定义（stdio / HTTP 两种传输共用）。 */
export interface ToolDefinition {
  name: string;
  title?: string;
  description: string;
  /** zod raw shape；无参数工具用空对象 `{}`。 */
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}
