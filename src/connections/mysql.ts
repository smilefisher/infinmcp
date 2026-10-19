import type { Pool } from "mysql2/promise";
import type { MysqlConnectionConfig } from "../config.js";
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

// MySQL 侧的类型别名（对外保持既有命名）。
export type MysqlQueryResult = SqlQueryResult;
export type MysqlSchemaResult = SqlSchemaResult;
export type MysqlRunOptions = SqlRunOptions;
export type MysqlSchemaOptions = SqlSchemaOptions;

/** 目标地址描述：host:port/database（用于错误信息，不含口令）。 */
export function describeMysqlTarget(config: MysqlConnectionConfig): string {
  return describeSqlTarget(config, "mysql");
}

/** 创建 MySQL 连接池（只读用途：禁多语句、大数保留为字符串、时间以字符串返回）。 */
export function createMysqlPool(config: MysqlConnectionConfig, timeoutMs: number): Pool {
  return createSqlPool(config, timeoutMs, "mysql");
}

/** 执行已验证的只读 SQL。 */
export async function mysqlQuery(
  pool: Pool,
  sql: string,
  params: unknown[],
  opts: MysqlRunOptions,
): Promise<MysqlQueryResult> {
  return sqlQuery(pool, sql, params, opts);
}

/** 查询库 / 表 / 列结构（内部生成 SQL，全部走 information_schema，参数化）。 */
export async function mysqlSchema(pool: Pool, opts: MysqlSchemaOptions): Promise<MysqlSchemaResult> {
  return sqlSchema(pool, opts);
}
