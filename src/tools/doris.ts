import { z } from "zod";
import { dorisQuery, dorisSchema } from "../connections/doris.js";
import { analyzeReadOnlySql, effectiveConnectionRowLimit } from "../readonly.js";
import type { ToolDefinition } from "./types.js";
import { formatRowsResult } from "./queryOutput.js";

const paramSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const dorisQueryTool: ToolDefinition = {
  name: "doris_query",
  title: "Doris 只读查询",
  description:
    "在指定 Doris 连接上执行只读 SQL（Doris 与 MySQL 协议兼容）。仅允许单条 " +
    "SELECT / SHOW / EXPLAIN / DESC / DESCRIBE / WITH 语句；禁止多语句与任何写操作。" +
    "返回行数受服务端 maxRows 限制。支持 columns 列裁剪、max_cell_width 截断；" +
    "output=auto 时大结果会自动导出到服务端文件，只返回前 20 行预览与下载信息" +
    "（导出文件保留完整值，不受截断影响）。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    sql: z.string().describe("只读 SQL，例如 SELECT id, name FROM users WHERE id = ?"),
    params: z.array(paramSchema).optional().describe("SQL 中 ? 占位符对应的参数"),
    limit: z.number().int().positive().optional().describe("期望返回行数上限（不会超过服务端 maxRows）"),
    columns: z.array(z.string()).optional().describe("只返回这些列（按给定顺序；列不存在会报错）"),
    max_cell_width: z
      .number()
      .int()
      .min(16)
      .max(65536)
      .optional()
      .describe("单元格最大字符数，默认取服务端 limits.maxCellWidth（512）"),
    output: z
      .enum(["auto", "inline", "file"])
      .optional()
      .describe("auto=结果过大时自动落文件（默认）；inline=始终直接返回；file=始终落文件"),
    format: z.enum(["jsonl", "csv"]).optional().describe("导出文件格式，默认 jsonl（仅落文件时生效）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const sql = typeof args.sql === "string" ? args.sql : "";
    const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
    const requested = typeof args.limit === "number" ? args.limit : undefined;

    const config = ctx.connections.getConfig(connection);
    const limit = effectiveConnectionRowLimit(requested, config.maxRows, ctx.config.limits.maxRows);

    const checked = analyzeReadOnlySql(sql, limit);
    if (!checked.ok) throw new Error(`拒绝执行: ${checked.reason}`);

    const pool = ctx.connections.dorisPool(connection);
    const result = await dorisQuery(pool, checked.sql!, params, {
      maxRows: limit,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `行数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;

    return formatRowsResult({
      ctx,
      args,
      connection,
      prefix: connection,
      header,
      availableColumns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      summaryPrefix: `doris_query on ${connection}`,
    });
  },
};

export const dorisSchemaTool: ToolDefinition = {
  name: "doris_schema",
  title: "Doris 结构查看",
  description:
    "查看 Doris 的库 / 表 / 列结构。不传 database 时列出所有库；传 database 时列出该库的表；" +
    "传 database + table 时列出该表的列与索引。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    database: z.string().optional().describe("库名；缺省使用连接配置里的默认库"),
    table: z.string().optional().describe("表名；提供且库已知时返回列与索引"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const database = typeof args.database === "string" ? args.database : undefined;
    const table = typeof args.table === "string" ? args.table : undefined;

    const config = ctx.connections.getConfig(connection);
    const defaultDatabase = config.type === "doris" ? config.database : undefined;

    const pool = ctx.connections.dorisPool(connection);
    const result = await dorisSchema(pool, {
      database,
      table,
      defaultDatabase,
      maxRows: effectiveConnectionRowLimit(undefined, config.maxRows, ctx.config.limits.maxRows),
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const label = result.database ? `（${result.database}）` : "";
    const header =
      `连接: ${connection}\n` +
      `模式: ${result.mode}${label}\n` +
      `行数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;
    const indexesText =
      result.indexes && result.indexes.length > 0 ? `\n\n索引:\n${JSON.stringify(result.indexes, null, 2)}` : "";

    return {
      text: `${header}\n\n${JSON.stringify(result.rows, null, 2)}${indexesText}`,
      structured: {
        mode: result.mode,
        database: result.database,
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
        ...(result.indexes ? { indexes: result.indexes } : {}),
      },
      connection,
      rowCount: result.rowCount,
      summary: `doris_schema on ${connection} (${result.mode})`,
    };
  },
};
