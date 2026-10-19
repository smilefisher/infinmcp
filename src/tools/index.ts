import type { ToolDefinition } from "./types.js";
import { listConnectionsTool } from "./meta.js";
import { mysqlQueryTool, mysqlSchemaTool } from "./mysql.js";
import { dorisQueryTool, dorisSchemaTool } from "./doris.js";
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
  mysqlSchemaTool,
  dorisQueryTool,
  dorisSchemaTool,
  redisExecTool,
  redisScanTool,
  mongoFindTool,
  mongoAggregateTool,
  mongoListCollectionsTool,
  mongoSchemaTool,
];

export type { ToolDefinition, ToolResult, ToolContext } from "./types.js";
