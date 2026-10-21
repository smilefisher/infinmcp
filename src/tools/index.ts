import type { ToolDefinition } from "./types.js";
import { listConnectionsTool } from "./meta.js";
import {
  createConnectionTool,
  deleteConnectionTool,
  testConnectionTool,
  updateConnectionTool,
} from "./connections.js";
import { mysqlQueryTool, mysqlSchemaTool } from "./mysql.js";
import { dorisQueryTool, dorisSchemaTool } from "./doris.js";
import { dorisBatchQueryTool, mysqlBatchQueryTool } from "./sqlBatch.js";
import { redisExecTool, redisScanTool } from "./redis.js";
import {
  mongoAggregateTool,
  mongoFindTool,
  mongoListCollectionsTool,
  mongoSchemaTool,
} from "./mongodb.js";

/** 全部工具定义；server 层按此注册。后续步骤在此追加新工具。 */
export const toolDefinitions: ToolDefinition[] = [
  listConnectionsTool,
  mysqlQueryTool,
  mysqlBatchQueryTool,
  mysqlSchemaTool,
  dorisQueryTool,
  dorisBatchQueryTool,
  dorisSchemaTool,
  redisExecTool,
  redisScanTool,
  mongoFindTool,
  mongoAggregateTool,
  mongoListCollectionsTool,
  mongoSchemaTool,
  createConnectionTool,
  updateConnectionTool,
  deleteConnectionTool,
  testConnectionTool,
];

export type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
