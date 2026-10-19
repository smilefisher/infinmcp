import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import { createMysqlPool, mysqlQuery, mysqlSchema } from "../src/connections/mysql.js";
import { analyzeReadOnlySql, effectiveRowLimit } from "../src/readonly.js";
import type { MysqlConnectionConfig } from "../src/config.js";
import type { Pool } from "mysql2/promise";

/**
 * 真实 MySQL 集成测试：仅在设置 INFINMCP_TEST_MYSQL 时运行。
 * 例：INFINMCP_TEST_MYSQL='mysql://ro:pass@127.0.0.1:3306/mysql' npm test
 */
const uri = process.env.INFINMCP_TEST_MYSQL;

function parseMysqlUri(value: string): MysqlConnectionConfig {
  const parsed = new URL(value);
  return {
    type: "mysql",
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    database: parsed.pathname.replace(/^\//, "") || undefined,
  };
}

describe.skipIf(!uri)("MySQL 集成（需要 INFINMCP_TEST_MYSQL）", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createMysqlPool(parseMysqlUri(uri!), 5000);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("SELECT 可用", async () => {
    const checked = analyzeReadOnlySql("SELECT 1 + 1 AS two", 100);
    expect(checked.ok).toBe(true);
    const result = await mysqlQuery(pool, checked.sql!, [], { maxRows: 100, timeoutMs: 5000 });
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ two: 2 });
  });

  it("行数上限生效（truncated）", async () => {
    const checked = analyzeReadOnlySql("SELECT 1 AS n UNION SELECT 2 UNION SELECT 3", 2);
    expect(checked.ok).toBe(true);
    const result = await mysqlQuery(pool, checked.sql!, [], {
      maxRows: effectiveRowLimit(2, 2),
      timeoutMs: 5000,
    });
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("写操作被守卫拒绝（未到达数据库）", () => {
    expect(analyzeReadOnlySql("DELETE FROM t", 100).ok).toBe(false);
    expect(analyzeReadOnlySql("SELECT 1; DROP TABLE t", 100).ok).toBe(false);
  });

  it("schema：列出数据库", async () => {
    const result = await mysqlSchema(pool, { maxRows: 100, timeoutMs: 5000 });
    expect(result.mode).toBe("databases");
    expect(result.rowCount).toBeGreaterThan(0);
  });

  it("ConnectionManager 端到端", async () => {
    const config: MysqlConnectionConfig = parseMysqlUri(uri!);
    const manager = new ConnectionManager({ connections: { t: config }, timeoutMs: 5000 });
    const checked = analyzeReadOnlySql("SELECT 1 AS one", 100);
    const result = await mysqlQuery(manager.mysqlPool("t"), checked.sql!, [], {
      maxRows: 100,
      timeoutMs: 5000,
    });
    expect(result.rows[0]).toMatchObject({ one: 1 });
    await manager.closeAll();
  });
});
