import type { z } from "zod";
import type { ConnectionConfig, LoadedConfig } from "../config.js";
import type { ConnectionManager } from "../connections/manager.js";
import type { Logger } from "../logging.js";

/**
 * 连接管理能力：仅在 HTTP `serve` 模式下由 server 层注入（stdio 模式为只读）。
 * 写盘 + 热生效的细节由注入方负责，工具只表达意图。
 */
export interface ConnectionManageCapability {
  /** 后台开关（Web 控制台勾选）：是否允许 AI 写连接。 */
  enabled: boolean;
  /** 新增 / 更新连接并返回落盘后的配置。 */
  upsert(name: string, rawConfig: Record<string, unknown>): Promise<ConnectionConfig>;
  /** 删除连接；返回是否确有删除（连接只存在于配置文件时为 false）。 */
  remove(name: string): Promise<boolean>;
}

/** 工具执行上下文：由 server 层注入。 */
export interface ToolContext {
  config: LoadedConfig;
  logger: Logger;
  /** 连接管理器（按连接名懒加载驱动句柄）。 */
  connections: ConnectionManager;
  /** 调用者身份：API Key 名称；stdio 模式下为 "local"。 */
  user: string;
  /** HTTP 模式下本次请求的公开基地址（用于拼接导出下载 URL）；stdio 模式缺省。 */
  publicBaseUrl?: string;
  /** 连接管理能力；stdio 模式未注入，写工具会明确报错。 */
  manage?: ConnectionManageCapability;
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
