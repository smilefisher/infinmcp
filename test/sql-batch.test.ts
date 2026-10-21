import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { dorisBatchQueryTool, mysqlBatchQueryTool } from "../src/tools/sqlBatch.js";
import type { ToolContext } from "../src/tools/types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-batch-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeContext(connections: Record<string, ConnectionConfig>): ToolContext {
  return {
    config: {
      dataDir,
      limits: {
        maxRows: 200,
        timeoutMs: 1000,
        maxCellWidth: 512,
        inlineMaxBytes: 262144,
        inlineMaxRows: 1000,
        exportTtlHours: 24,
        exportMaxFiles: 200,
      },
    } as unknown as LoadedConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    connections: new ConnectionManager({ connections, timeoutMs: 1000 }),
    user: "tester",
  };
}

interface FakePoolOptions {
  onQuery?: (sql: string) => void;
  failOn?: string;
  value?: (index: number) => unknown;
}

function fakePool(options: FakePoolOptions = {}) {
  let index = 0;
  return {
    getConnection: async () => ({
      query: async (request: { sql: string }) => {
        index += 1;
        options.onQuery?.(request.sql);
        if (options.failOn && request.sql.includes(options.failOn)) {
          throw new Error(`Table '${options.failOn}' doesn't exist`);
        }
        const value = options.value ? options.value(index) : index;
        return [[{ v: value }], [{ name: "v" }]];
      },
      release: () => undefined,
    }),
  };
}

function useMysqlPool(ctx: ToolContext, pool: unknown): void {
  (ctx.connections as unknown as { mysqlPool: () => unknown }).mysqlPool = () => pool;
}

function useDorisPool(ctx: ToolContext, pool: unknown): void {
  (ctx.connections as unknown as { dorisPool: () => unknown }).dorisPool = () => pool;
}

describe("mysql_batch_query", () => {
  it("顺序执行并按 name 分段；单条失败不中断，只读校验失败的不会执行", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    const calls: string[] = [];
    useMysqlPool(
      ctx,
      fakePool({ onQuery: (sql) => calls.push(sql), failOn: "missing_table" }),
    );

    const result = await mysqlBatchQueryTool.handler(
      {
        connection: "main",
        queries: [
          { name: "first", sql: "SELECT 1 AS v" },
          { name: "broken", sql: "SELECT * FROM missing_table" },
          { name: "third", sql: "SELECT 3 AS v", columns: ["v"] },
          { name: "rejected", sql: "DELETE FROM t" },
        ],
      },
      ctx,
    );

    const structured = result.structured as {
      queryCount: number;
      succeeded: number;
      failed: number;
      totalRows: number;
      results: Array<{ name: string; ok: boolean; error?: string }>;
    };
    expect(structured).toMatchObject({ queryCount: 4, succeeded: 2, failed: 2, totalRows: 2 });
    expect(structured.results.map((item) => [item.name, item.ok])).toEqual([
      ["first", true],
      ["broken", false],
      ["third", true],
      ["rejected", false],
    ]);
    expect(structured.results[1]!.error).toContain("doesn't exist");
    expect(structured.results[3]!.error).toMatch(/拒绝执行/);
    expect(calls).toHaveLength(3);
    expect(calls.some((sql) => sql.toUpperCase().includes("DELETE"))).toBe(false);
    expect(result.text).toContain("成功 2 / 失败 2");
    expect(result.text).toContain("=== [first] ===");
    expect(result.text).toContain("=== [broken] 失败 ===");
    expect(result.summary).toContain("2 ok, 2 failed");
  });

  it("name 重复时整体拒绝且不执行任何 SQL", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    const calls: string[] = [];
    useMysqlPool(ctx, fakePool({ onQuery: (sql) => calls.push(sql) }));

    await expect(
      mysqlBatchQueryTool.handler(
        {
          connection: "main",
          queries: [
            { name: "same", sql: "SELECT 1" },
            { name: "same", sql: "SELECT 2" },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/不能重复/);
    expect(calls).toHaveLength(0);
  });

  it("缺省 name 使用 q1..qN", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    useMysqlPool(ctx, fakePool());

    const result = await mysqlBatchQueryTool.handler(
      { connection: "main", queries: [{ sql: "SELECT 1" }, { sql: "SELECT 2" }] },
      ctx,
    );
    const structured = result.structured as {
      results: Array<{ name: string; ok: boolean }>;
    };
    expect(structured.results.map((item) => item.name)).toEqual(["q1", "q2"]);
  });

  it("单条 columns 不存在只影响该条", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    useMysqlPool(ctx, fakePool());

    const result = await mysqlBatchQueryTool.handler(
      {
        connection: "main",
        queries: [
          { name: "bad", sql: "SELECT 1 AS v", columns: ["nope"] },
          { name: "ok", sql: "SELECT 2 AS v" },
        ],
      },
      ctx,
    );
    const structured = result.structured as {
      succeeded: number;
      failed: number;
      results: Array<{ name: string; ok: boolean; error?: string }>;
    };
    expect(structured).toMatchObject({ succeeded: 1, failed: 1 });
    expect(structured.results[0]!.error).toMatch(/不存在的列/);
    expect(structured.results[1]!.ok).toBe(true);
  });

  it("每条可单独 output=file，并返回导出元信息", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    useMysqlPool(ctx, fakePool());

    const result = await mysqlBatchQueryTool.handler(
      {
        connection: "main",
        queries: [{ name: "export", sql: "SELECT 1 AS v", output: "file", format: "csv" }],
      },
      ctx,
    );
    const structured = result.structured as {
      results: Array<{
        name: string;
        ok: boolean;
        preview: Array<Record<string, unknown>>;
        export: { file: string; format: string; rowCount: number };
      }>;
    };
    const item = structured.results[0]!;
    expect(item.export).toMatchObject({ format: "csv", rowCount: 1 });
    expect(item.preview).toHaveLength(1);
    expect(existsSync(join(dataDir, "exports", item.export.file))).toBe(true);
    expect(result.text).toContain(`已导出 1 行到文件`);
  });

  it("批量级 max_cell_width 作用于所有查询（inline）", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    useMysqlPool(ctx, fakePool({ value: () => "z".repeat(80) }));

    const result = await mysqlBatchQueryTool.handler(
      {
        connection: "main",
        queries: [{ name: "long", sql: "SELECT 1 AS v" }],
        max_cell_width: 20,
      },
      ctx,
    );
    const structured = result.structured as {
      results: Array<{ truncatedCells: number; rows: Array<Record<string, unknown>> }>;
    };
    expect(structured.results[0]!.truncatedCells).toBe(1);
    expect(String(structured.results[0]!.rows[0]!.v)).toContain("已截断");
    expect(result.text).toContain("截断单元格: 1");
  });

  it("queries 为空时拒绝", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    await expect(
      mysqlBatchQueryTool.handler({ connection: "main", queries: [] }, ctx),
    ).rejects.toThrow(/至少需要 1 条/);
  });
});

describe("doris_batch_query", () => {
  it("走 Doris 连接池并返回分段结果", async () => {
    const ctx = makeContext({ dw: { type: "doris", host: "h", user: "ro" } });
    useDorisPool(ctx, fakePool());

    const result = await dorisBatchQueryTool.handler(
      { connection: "dw", queries: [{ name: "one", sql: "SELECT 1 AS v" }] },
      ctx,
    );
    expect(result.connection).toBe("dw");
    expect(result.structured).toMatchObject({ queryCount: 1, succeeded: 1, failed: 0 });
    expect(result.text).toContain("=== [one] ===");
  });
});
