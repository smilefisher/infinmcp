import type { Pool } from "mysql2/promise";
import type { DorisConnectionConfig } from "../config.js";
import {
  createSqlPool,
  describeSqlTarget,
  sqlQuery,
  sqlSchema,
  type SqlQueryResult,
  type SqlRunOptions,
  type SqlSchemaOptions,
  type SqlSchemaResult,
} from "./sql.js";

/**
 * Apache Doris（FE 的 MySQL 协议端口，默认 9030）只读连接。
 *
 * Doris 与 MySQL 协议兼容，直接复用 mysql2 驱动与只读 SQL 守卫；
 * 结构与查询都走 information_schema，行为与 MySQL 保持一致。
 */
export type DorisQueryResult = SqlQueryResult;
export type DorisSchemaResult = SqlSchemaResult;
export type DorisRunOptions = SqlRunOptions;
export type DorisSchemaOptions = SqlSchemaOptions;

/** 目标地址描述：host:port/database（用于错误信息，不含口令）。 */
export function describeDorisTarget(config: DorisConnectionConfig): string {
  return describeSqlTarget(config, "doris");
}

/** 创建 Doris 连接池（默认端口 9030；只读用途：禁多语句、大数保留为字符串、时间以字符串返回）。 */
export function createDorisPool(config: DorisConnectionConfig, timeoutMs: number): Pool {
  return createSqlPool(config, timeoutMs, "doris");
}

/** 执行已验证的只读 SQL。 */
export async function dorisQuery(
  pool: Pool,
  sql: string,
  params: unknown[],
  opts: DorisRunOptions,
): Promise<DorisQueryResult> {
  return sqlQuery(pool, sql, params, opts);
}

/** 查询库 / 表 / 列结构（内部生成 SQL，全部走 information_schema，参数化）。 */
export async function dorisSchema(pool: Pool, opts: DorisSchemaOptions): Promise<DorisSchemaResult> {
  return sqlSchema(pool, opts);
}
