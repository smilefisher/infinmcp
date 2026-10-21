import { z } from "zod";
import type { Pool } from "mysql2/promise";
import { dorisQuery } from "../connections/doris.js";
import { mysqlQuery } from "../connections/mysql.js";
import type { SqlQueryResult, SqlRunOptions } from "../connections/sql.js";
import { analyzeReadOnlySql, effectiveConnectionRowLimit } from "../readonly.js";
import { formatRowsResult } from "./queryOutput.js";
import type { ToolContext, ToolDefinition, ToolResult } from "./types.js";

const paramSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const querySchema = z.object({
  name: z
    .string()
    .max(64)
    .optional()
    .describe("结果分组名；缺省 q1..qN；同一次调用内必须唯一（最多 64 字符）"),
  sql: z.string().describe("单条只读 SQL"),
  params: z.array(paramSchema).optional().describe("SQL 中 ? 占位符对应的参数"),
  limit: z.number().int().positive().optional().describe("该条查询的行数上限（不会超过服务端 maxRows）"),
  columns: z.array(z.string()).optional().describe("该条查询只返回这些列（列不存在时该条失败）"),
  output: z
    .enum(["auto", "inline", "file"])
    .optional()
    .describe("该条查询的输出方式；缺省 auto（结果过大时落文件）"),
  format: z.enum(["jsonl", "csv"]).optional().describe("该条查询落文件时的格式，缺省 jsonl"),
});

function batchInputSchema(): Record<string, z.ZodType> {
  return {
    connection: z.string().describe("连接名，见 list_connections"),
    queries: z
      .array(querySchema)
      .min(1)
      .max(20)
      .describe("1–20 条只读 SQL；按数组顺序执行，单条失败不中断"),
    max_cell_width: z
      .number()
      .int()
      .min(16)
      .max(65536)
      .optional()
      .describe("所有查询共用的单元格最大字符数，默认取服务端 limits.maxCellWidth（512）"),
  };
}

type BatchOutput = "auto" | "inline" | "file";
type BatchFormat = "jsonl" | "csv";

interface BatchQuery {
  name: string;
  sql: string;
  params: unknown[];
  limit?: number;
  columns?: string[];
  output?: BatchOutput;
  format?: BatchFormat;
}

interface SqlBatchFlavor {
  toolName: string;
  title: string;
  description: string;
  pool: (ctx: ToolContext, connection: string) => Pool;
  run: (
    pool: Pool,
    sql: string,
    params: unknown[],
    options: SqlRunOptions,
  ) => Promise<SqlQueryResult>;
}

function normalizeQuery(raw: unknown, index: number): BatchQuery {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`queries[${index}] 必须是对象`);
  }
  const item = raw as Record<string, unknown>;
  const sql = typeof item.sql === "string" ? item.sql.trim() : "";
  if (!sql) throw new Error(`queries[${index}] 缺少 sql`);

  const rawName = typeof item.name === "string" ? item.name.trim() : "";
  const name = rawName || `q${index + 1}`;
  if (name.length > 64) throw new Error(`queries[${index}] 的 name 最多 64 字符`);

  return {
    name,
    sql,
    params: Array.isArray(item.params) ? item.params : [],
    ...(typeof item.limit === "number" ? { limit: item.limit } : {}),
    ...(Array.isArray(item.columns) ? { columns: item.columns as string[] } : {}),
    ...(item.output === "auto" || item.output === "inline" || item.output === "file"
      ? { output: item.output }
      : {}),
    ...(item.format === "jsonl" || item.format === "csv" ? { format: item.format } : {}),
  };
}

function createSqlBatchTool(flavor: SqlBatchFlavor): ToolDefinition {
  return {
    name: flavor.toolName,
    title: flavor.title,
    description: flavor.description,
    inputSchema: batchInputSchema(),
    async handler(args, ctx): Promise<ToolResult> {
      const connection = typeof args.connection === "string" ? args.connection : "";
      if (!connection) throw new Error("缺少参数 connection");

      const rawQueries = Array.isArray(args.queries) ? args.queries : [];
      if (rawQueries.length === 0) throw new Error("queries 至少需要 1 条");
      if (rawQueries.length > 20) throw new Error("queries 最多 20 条");

      const maxCellWidth =
        typeof args.max_cell_width === "number" ? args.max_cell_width : undefined;

      const queries = rawQueries.map((raw, index) => normalizeQuery(raw, index));
      const seen = new Set<string>();
      for (const query of queries) {
        if (seen.has(query.name)) {
          throw new Error(`queries 的 name 不能重复: "${query.name}"`);
        }
        seen.add(query.name);
      }

      const config = ctx.connections.getConfig(connection);
      // 连接类型/存在性错误在循环前直接抛出，避免 20 条重复报错。
      const pool = flavor.pool(ctx, connection);

      const results: Array<Record<string, unknown>> = [];
      const sections: string[] = [];
      let succeeded = 0;
      let failed = 0;
      let totalRows = 0;

      // 同一连接顺序执行；单条失败只记录错误，继续下一条；不开事务。
      for (const query of queries) {
        try {
          const limit = effectiveConnectionRowLimit(
            query.limit,
            config.maxRows,
            ctx.config.limits.maxRows,
          );
          const checked = analyzeReadOnlySql(query.sql, limit);
          if (!checked.ok) throw new Error(`拒绝执行: ${checked.reason}`);

          const result = await flavor.run(pool, checked.sql!, query.params, {
            maxRows: limit,
            timeoutMs: ctx.config.limits.timeoutMs,
          });

          const header =
            `连接: ${connection}\n` +
            `查询: ${query.name}\n` +
            `行数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;
          const outputArgs: Record<string, unknown> = {
            ...(query.columns ? { columns: query.columns } : {}),
            ...(query.output ? { output: query.output } : {}),
            ...(query.format ? { format: query.format } : {}),
            ...(maxCellWidth !== undefined ? { max_cell_width: maxCellWidth } : {}),
          };

          const shaped = formatRowsResult({
            ctx,
            args: outputArgs,
            connection,
            prefix: `${connection}-${query.name}`,
            header,
            availableColumns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            summaryPrefix: `${flavor.toolName}[${query.name}] on ${connection}`,
          });

          succeeded += 1;
          totalRows += result.rowCount;
          results.push({ name: query.name, ok: true, ...(shaped.structured ?? {}) });
          sections.push(`=== [${query.name}] ===\n${shaped.text}`);
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          results.push({ name: query.name, ok: false, error: message });
          sections.push(`=== [${query.name}] 失败 ===\n错误: ${message}`);
        }
      }

      const text = [
        `连接: ${connection}\n查询数: ${queries.length}（成功 ${succeeded} / 失败 ${failed}）`,
        ...sections,
      ].join("\n\n");

      return {
        text,
        structured: {
          connection,
          queryCount: queries.length,
          succeeded,
          failed,
          totalRows,
          results,
        },
        connection,
        rowCount: totalRows,
        summary:
          `${flavor.toolName} on ${connection} ` +
          `(${queries.length} queries, ${succeeded} ok, ${failed} failed)`,
      };
    },
  };
}

export const mysqlBatchQueryTool = createSqlBatchTool({
  toolName: "mysql_batch_query",
  title: "MySQL 批量只读查询",
  description:
    "在一次调用中顺序执行 1–20 条只读 SQL（MySQL 协议），按 name 分段返回结果。" +
    "单条失败不中断：该条返回 error，其余继续；同一连接、不开事务。" +
    "每条可单独指定 params / limit / columns / output / format；" +
    "output=auto 时大结果会导出到服务端文件，只返回前 20 行预览与下载信息。",
  pool: (ctx, connection) => ctx.connections.mysqlPool(connection),
  run: mysqlQuery,
});

export const dorisBatchQueryTool = createSqlBatchTool({
  toolName: "doris_batch_query",
  title: "Doris 批量只读查询",
  description:
    "在一次调用中顺序执行 1–20 条只读 SQL（Doris 与 MySQL 协议兼容），按 name 分段返回结果。" +
    "单条失败不中断：该条返回 error，其余继续；同一连接、不开事务。" +
    "每条可单独指定 params / limit / columns / output / format；" +
    "output=auto 时大结果会导出到服务端文件，只返回前 20 行预览与下载信息。",
  pool: (ctx, connection) => ctx.connections.dorisPool(connection),
  run: dorisQuery,
});
