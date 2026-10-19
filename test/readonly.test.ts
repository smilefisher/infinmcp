import { describe, expect, it } from "vitest";
import { analyzeReadOnlySql, effectiveRowLimit, maskSqlLiterals } from "../src/readonly.js";

const LIMIT = 100;

function ok(sql: string) {
  const result = analyzeReadOnlySql(sql, LIMIT);
  expect(result.ok, `期望允许但被拒绝: ${sql} (${result.reason})`).toBe(true);
  return result;
}

function rejected(sql: string) {
  const result = analyzeReadOnlySql(sql, LIMIT);
  expect(result.ok, `期望拒绝但被允许: ${sql}`).toBe(false);
  return result;
}

describe("analyzeReadOnlySql · 允许", () => {
  it("SELECT 自动追加 LIMIT", () => {
    const result = ok("SELECT 1");
    expect(result.kind).toBe("select");
    expect(result.limitAppended).toBe(true);
    expect(result.sql).toBe("SELECT 1 LIMIT 100");
  });

  it("已有顶层 LIMIT 时不追加", () => {
    const result = ok("SELECT * FROM t LIMIT 5");
    expect(result.limitAppended).toBe(false);
    expect(result.sql).toBe("SELECT * FROM t LIMIT 5");
  });

  it("子查询里的 LIMIT 不算顶层，仍会追加", () => {
    const result = ok("SELECT * FROM (SELECT 1 LIMIT 1) x");
    expect(result.limitAppended).toBe(true);
  });

  it("去掉尾部多余分号", () => {
    const result = ok("SELECT * FROM t LIMIT 5 ;  ");
    expect(result.sql).toBe("SELECT * FROM t LIMIT 5");
  });

  it("SHOW / EXPLAIN / DESC / DESCRIBE 允许且不追加", () => {
    for (const sql of ["SHOW TABLES", "EXPLAIN SELECT 1", "DESC users", "DESCRIBE users"]) {
      const result = ok(sql);
      expect(result.limitAppended).toBe(false);
    }
  });

  it("WITH ... SELECT 允许并追加 LIMIT", () => {
    const result = ok("WITH c AS (SELECT 1) SELECT * FROM c");
    expect(result.kind).toBe("with");
    expect(result.limitAppended).toBe(true);
  });

  it("前导注释不影响识别", () => {
    const result = ok("/* hi */ SELECT 1");
    expect(result.kind).toBe("select");
  });

  it("字符串常量中的写关键字/分号不算数", () => {
    ok("SELECT 'delete from users' AS x");
    ok("SELECT ';' AS y");
    ok("SELECT 'into outfile' AS z");
  });
});

describe("analyzeReadOnlySql · 拒绝", () => {
  it("空 SQL", () => {
    expect(analyzeReadOnlySql("   ", LIMIT).ok).toBe(false);
  });

  it("写操作与 DDL", () => {
    for (const sql of [
      "INSERT INTO t VALUES (1)",
      "UPDATE t SET x = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "TRUNCATE t",
      "REPLACE INTO t VALUES (1)",
      "CREATE TABLE t (id int)",
    ]) {
      rejected(sql);
    }
  });

  it("多语句", () => {
    rejected("SELECT 1; DROP TABLE t");
    rejected("SELECT 1;SELECT 2");
  });

  it("文件写入 / 加锁 / 危险函数", () => {
    rejected("SELECT * FROM t INTO OUTFILE '/tmp/x'");
    rejected("SELECT * FROM t INTO DUMPFILE '/tmp/x'");
    rejected("SELECT * FROM t FOR UPDATE");
    rejected("SELECT * FROM t FOR SHARE");
    rejected("SELECT * FROM t LOCK IN SHARE MODE");
    rejected("SELECT LOAD_FILE('/etc/passwd')");
    rejected("SELECT 1 INTO @x");
  });

  it("EXPLAIN ANALYZE 会真正执行，拒绝", () => {
    rejected("EXPLAIN ANALYZE DELETE FROM t");
    rejected("EXPLAIN ANALYZE SELECT 1");
  });

  it("WITH 主导写操作被拒绝", () => {
    rejected("WITH c AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT * FROM c)");
    rejected("WITH c AS (SELECT 1) UPDATE t SET x = 1");
  });
});

describe("maskSqlLiterals / effectiveRowLimit", () => {
  it("抹平字符串与注释内容", () => {
    expect(maskSqlLiterals("SELECT 'abc' -- x")).toContain("SELECT");
    expect(maskSqlLiterals("SELECT 'abc'")).not.toContain("abc");
  });

  it("行数上限不超过服务端 maxRows", () => {
    expect(effectiveRowLimit(undefined, 200)).toBe(200);
    expect(effectiveRowLimit(10, 200)).toBe(10);
    expect(effectiveRowLimit(9999, 200)).toBe(200);
    expect(effectiveRowLimit(0, 200)).toBe(200);
  });
});
