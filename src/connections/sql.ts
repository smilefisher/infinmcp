import { createPool, type Pool } from "mysql2/promise";
import type { DorisConnectionConfig, MysqlConnectionConfig } from "../config.js";
import { rowToJsonSafe } from "../json.js";

/**
 * MySQL 协议兼容数据库（MySQL / Doris）的公共实现。
 *
 * Doris 的 FE 通过 MySQL 协议对外提供查询能力，因此可以直接复用 mysql2 驱动：
 * 两者的连接字段、只读 SQL 守卫与 information_schema 结构查询都一致，
 * 差别只在默认端口与错误信息里的数据库名（由 flavor 决定）。
 */
export type SqlFlavor = "mysql" | "doris";

/** 连接配置中「SQL 类」连接的公共字段（mysql / doris 同构）。 */
export type SqlConnectionConfig = MysqlConnectionConfig | DorisConnectionConfig;

export interface SqlQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface SqlSchemaResult extends SqlQueryResult {
  mode: "databases" | "tables" | "columns";
  database?: string;
  indexes?: Array<Record<string, unknown>>;
}

export interface SqlRunOptions {
  maxRows: number;
  timeoutMs: number;
}

export interface SqlSchemaOptions extends SqlRunOptions {
  database?: string;
  table?: string;
  defaultDatabase?: string;
}

interface FlavorMeta {
  /** 出现在错误信息里的数据库名，例如 "MySQL" / "Doris"。 */
  label: string;
  defaultPort: number;
}

const FLAVORS: Record<SqlFlavor, FlavorMeta> = {
  mysql: { label: "MySQL", defaultPort: 3306 },
  doris: { label: "Doris", defaultPort: 9030 },
};

/** 视为「连不上」的驱动错误码（而不是 SQL 本身的错误）。 */
const CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "ER_ACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_CON_COUNT_ERROR",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
  "PROTOCOL_SEQUENCE_TIMEOUT",
]);

interface PoolMeta {
  /** 目标地址描述：host:port/database（用于错误信息，不含口令）。 */
  target: string;
  /** 数据库名（MySQL / Doris），用于拼接错误信息。 */
  label: string;
}

/**
 * 池 → 目标地址描述。mysql2 的池不保留 host/port，而报错时需要带上地址，
 * 因此在建池时登记一份；池只由本模块的 createSqlPool 创建。
 */
const poolMetas = new WeakMap<Pool, PoolMeta>();

/** 目标地址描述：host:port/database（用于错误信息，不含口令）。 */
export function describeSqlTarget(config: SqlConnectionConfig, flavor: SqlFlavor): string {
  const host = config.host || "?";
  const port = config.port ?? FLAVORS[flavor].defaultPort;
  return config.database ? `${host}:${port}/${config.database}` : `${host}:${port}`;
}

function isConnectError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && CONNECT_ERROR_CODES.has(code)) return true;
  // mysql2 对连接级故障会打上 fatal 标记
  return (error as { fatal?: unknown }).fatal === true;
}

/**
 * 把连接级错误包装成可读信息，风格与 Redis / MongoDB 一致：
 * `无法连接 <label> (host:port/db): <驱动原因>`；SQL 自身错误原样抛出。
 */
function wrapSqlError(error: unknown, meta: PoolMeta): Error {
  const reason = error instanceof Error ? error.message : String(error);
  if (isConnectError(error)) return new Error(`无法连接 ${meta.label} (${meta.target}): ${reason}`);
  return error instanceof Error ? error : new Error(reason);
}

/** 创建 MySQL 协议连接池（只读用途：禁多语句、大数保留为字符串、时间以字符串返回）。 */
export function createSqlPool(config: SqlConnectionConfig, timeoutMs: number, flavor: SqlFlavor): Pool {
  const pool = createPool({
    host: config.host,
    port: config.port ?? FLAVORS[flavor].defaultPort,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: config.charset,
    waitForConnections: true,
    connectionLimit: 4,
    queueLimit: 0,
    multipleStatements: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
    connectTimeout: timeoutMs,
  });
  poolMetas.set(pool, { target: describeSqlTarget(config, flavor), label: FLAVORS[flavor].label });
  return pool;
}

async function runQuery(
  pool: Pool,
  sql: string,
  params: unknown[],
  opts: SqlRunOptions,
): Promise<SqlQueryResult> {
  const meta = poolMetas.get(pool) ?? { target: "?", label: "MySQL" };
  try {
    const connection = await pool.getConnection();
    try {
      const [rows, fields] = await connection.query({ sql, values: params, timeout: opts.timeoutMs });
      const columns = (fields ?? []).map((field) => field.name);
      const list = Array.isArray(rows) ? rows : [];
      const mapped = list.map((row) => rowToJsonSafe(row as Record<string, unknown>));
      const truncated = mapped.length > opts.maxRows;
      const limited = truncated ? mapped.slice(0, opts.maxRows) : mapped;
      return { columns, rows: limited, rowCount: limited.length, truncated };
    } finally {
      connection.release();
    }
  } catch (error) {
    throw wrapSqlError(error, meta);
  }
}

/** 执行已验证的只读 SQL。 */
export async function sqlQuery(
  pool: Pool,
  sql: string,
  params: unknown[],
  opts: SqlRunOptions,
): Promise<SqlQueryResult> {
  return runQuery(pool, sql, params, opts);
}

/** 查询库 / 表 / 列结构（内部生成 SQL，全部走 information_schema，参数化）。 */
export async function sqlSchema(pool: Pool, opts: SqlSchemaOptions): Promise<SqlSchemaResult> {
  const database = opts.database ?? opts.defaultDatabase;

  if (opts.table) {
    if (!database) {
      throw new Error("需要指定 database（或该连接配置里的默认库）才能查看表结构");
    }
    const columns = await runQuery(
      pool,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [database, opts.table],
      opts,
    );
    const indexes = await runQuery(
      pool,
      `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [database, opts.table],
      opts,
    );
    return { ...columns, mode: "columns", database, indexes: indexes.rows };
  }

  if (database) {
    const tables = await runQuery(
      pool,
      `SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ?
        ORDER BY TABLE_NAME`,
      [database],
      opts,
    );
    return { ...tables, mode: "tables", database };
  }

  const databases = await runQuery(
    pool,
    `SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
       FROM information_schema.SCHEMATA
      ORDER BY SCHEMA_NAME`,
    [],
    opts,
  );
  return { ...databases, mode: "databases" };
}
