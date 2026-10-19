import { z } from "zod";
import { mysqlQuery, mysqlSchema } from "../connections/mysql.js";
import { analyzeReadOnlySql, effectiveRowLimit } from "../readonly.js";
import type { ToolDefinition } from "./types.js";

const paramSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const mysqlQueryTool: ToolDefinition = {
  name: "mysql_query",
  title: "MySQL 只读查询",
  description:
    "在指定 MySQL 连接上执行只读 SQL。仅允许单条 SELECT / SHOW / EXPLAIN / DESC / DESCRIBE / WITH 语句；" +
    "禁止多语句与任何写操作（含 INTO OUTFILE、FOR UPDATE、EXPLAIN ANALYZE）。返回行数受服务端 maxRows 限制。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    sql: z.string().describe("只读 SQL，例如 SELECT id, name FROM users WHERE id = ?"),
    params: z.array(paramSchema).optional().describe("SQL 中 ? 占位符对应的参数"),
    limit: z.number().int().positive().optional().describe("期望返回行数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const sql = typeof args.sql === "string" ? args.sql : "";
    const params = Array.isArray(args.params) ? (args.params as unknown[]) : [];
    const requested = typeof args.limit === "number" ? args.limit : undefined;

    const limit = effectiveRowLimit(requested, ctx.config.limits.maxRows);

    const checked = analyzeReadOnlySql(sql, limit);
    if (!checked.ok) throw new Error(`拒绝执行: ${checked.reason}`);

    const pool = ctx.connections.mysqlPool(connection);
    const result = await mysqlQuery(pool, checked.sql!, params, {
      maxRows: limit,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `行数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}\n` +
      `列: ${result.columns.join(", ") || "(无)"}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.rows, null, 2)}`,
      structured: {
        columns: result.columns,
        rows: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
      },
      connection,
      rowCount: result.rowCount,
      summary: `mysql_query on ${connection} (${result.rowCount} rows${result.truncated ? ", truncated" : ""})`,
    };
  },
};

export const mysqlSchemaTool: ToolDefinition = {
  name: "mysql_schema",
  title: "MySQL 结构查看",
  description:
    "查看 MySQL 的库 / 表 / 列结构。不传 database 时列出所有库；传 database 时列出该库的表；" +
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
    const defaultDatabase = config.type === "mysql" ? config.database : undefined;

    const pool = ctx.connections.mysqlPool(connection);
    const result = await mysqlSchema(pool, {
      database,
      table,
      defaultDatabase,
      maxRows: ctx.config.limits.maxRows,
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
      summary: `mysql_schema on ${connection} (${result.mode})`,
    };
  },
};
