import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { dorisQueryTool } from "../src/tools/doris.js";
import { mysqlQueryTool } from "../src/tools/mysql.js";
import { formatRowsResult } from "../src/tools/queryOutput.js";
import type { ToolContext } from "../src/tools/types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-qout-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeContext(
  options: {
    connections?: Record<string, ConnectionConfig>;
    publicBaseUrl?: string;
    limits?: Partial<LoadedConfig["limits"]>;
  } = {},
): ToolContext {
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
        ...options.limits,
      },
    } as unknown as LoadedConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    connections: new ConnectionManager({ connections: options.connections ?? {}, timeoutMs: 1000 }),
    user: "tester",
    ...(options.publicBaseUrl ? { publicBaseUrl: options.publicBaseUrl } : {}),
  };
}

const rows = [
  { id: 1, name: "x".repeat(30) },
  { id: 2, name: "short" },
];
const fields = [{ name: "id" }, { name: "name" }];

function fakePool(resultRows: Array<Record<string, unknown>>, fieldList = fields) {
  return {
    getConnection: async () => ({
      query: async () => [resultRows, fieldList],
      release: () => undefined,
    }),
  };
}

describe("formatRowsResult", () => {
  it("columns 裁剪 + max_cell_width 截断（inline）", () => {
    const ctx = makeContext();
    const result = formatRowsResult({
      ctx,
      args: { columns: ["name"], max_cell_width: 20 },
      connection: "main",
      prefix: "main",
      header: "连接: main\n行数: 2",
      availableColumns: ["id", "name"],
      rows,
      rowCount: 2,
      truncated: false,
      summaryPrefix: "mysql_query on main",
    });

    expect(result.structured).toMatchObject({
      columns: ["name"],
      rowCount: 2,
      truncated: false,
      truncatedCells: 1,
    });
    const structuredRows = result.structured!.rows as Array<Record<string, unknown>>;
    expect(structuredRows[0]).toHaveProperty("name");
    expect(structuredRows[0]).not.toHaveProperty("id");
    expect(String(structuredRows[0]!.name)).toContain("已截断");
    expect(structuredRows[1]!.name).toBe("short");
    expect(result.text).toContain("列: name");
    expect(result.text).toContain("截断单元格: 1");
  });

  it("请求不存在的列时给出可用列", () => {
    expect(() =>
      formatRowsResult({
        ctx: makeContext(),
        args: { columns: ["nope"] },
        connection: "main",
        prefix: "main",
        header: "连接: main",
        availableColumns: ["id", "name"],
        rows,
        rowCount: 2,
        truncated: false,
        summaryPrefix: "mysql_query on main",
      }),
    ).toThrowError(/不存在的列: nope.*可用列: id, name/);
  });

  it("output=file 时只给前 20 行预览与导出元信息", () => {
    const ctx = makeContext({ publicBaseUrl: "http://example.test:8787" });
    const many = Array.from({ length: 25 }, (_, index) => ({ id: index }));
    const result = formatRowsResult({
      ctx,
      args: { output: "file", format: "csv" },
      connection: "main",
      prefix: "main",
      header: "连接: main\n行数: 25",
      availableColumns: ["id"],
      rows: many,
      rowCount: 25,
      truncated: false,
      summaryPrefix: "mysql_query on main",
    });

    const structured = result.structured as {
      rows?: unknown;
      preview: Array<Record<string, unknown>>;
      export: { file: string; format: string; rowCount: number; downloadPath: string; downloadUrl: string };
    };
    expect(structured.rows).toBeUndefined();
    expect(structured.preview).toHaveLength(20);
    expect(structured.export).toMatchObject({ format: "csv", rowCount: 25 });
    expect(structured.export.downloadPath).toBe(`/api/exports/${structured.export.file}`);
    expect(structured.export.downloadUrl).toBe(
      `http://example.test:8787/api/exports/${structured.export.file}`,
    );
    expect(existsSync(join(dataDir, "exports", structured.export.file))).toBe(true);
    expect(result.text).toContain("已导出 25 行");
    expect(result.text).toContain("预览（前 20 行）");
    expect(result.summary).toContain("exported csv");
  });

  it("落文件保留完整单元格，只有预览被截断", () => {
    const long = "y".repeat(100);
    const result = formatRowsResult({
      ctx: makeContext(),
      args: { output: "file", format: "jsonl", max_cell_width: 20 },
      connection: "main",
      prefix: "main",
      header: "连接: main",
      availableColumns: ["text"],
      rows: [{ text: long }],
      rowCount: 1,
      truncated: false,
      summaryPrefix: "mysql_query on main",
    });
    const structured = result.structured as {
      preview: Array<Record<string, unknown>>;
      truncatedCells: number;
      export: { file: string };
    };
    expect(structured.truncatedCells).toBe(1);
    expect(String(structured.preview[0]!.text)).toContain("已截断");
    expect(readFileSync(join(dataDir, "exports", structured.export.file), "utf8")).toContain(long);
    expect(result.text).toContain("预览截断单元格: 1");
  });

  it("auto 超过 inlineMaxRows 时落文件（stdio 无 publicBaseUrl 时给下载路径）", () => {
    const ctx = makeContext({ limits: { inlineMaxRows: 2 } });
    const result = formatRowsResult({
      ctx,
      args: {},
      connection: "main",
      prefix: "main",
      header: "连接: main",
      availableColumns: ["id"],
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      rowCount: 3,
      truncated: false,
      summaryPrefix: "mysql_query on main",
    });
    const structured = result.structured as {
      export: { file: string; downloadPath: string; downloadUrl?: string };
    };
    expect(structured.export).toBeDefined();
    expect(structured.export.downloadPath).toMatch(/^\/api\/exports\//);
    expect(structured.export.downloadUrl).toBeUndefined();
    expect(result.text).toContain("下载路径");
  });

  it("auto 未超阈值时直接返回", () => {
    const ctx = makeContext({ limits: { inlineMaxRows: 10 } });
    const result = formatRowsResult({
      ctx,
      args: {},
      connection: "main",
      prefix: "main",
      header: "连接: main",
      availableColumns: ["id"],
      rows: [{ id: 1 }],
      rowCount: 1,
      truncated: false,
      summaryPrefix: "mysql_query on main",
    });
    expect(result.structured).toMatchObject({ rows: [{ id: 1 }], truncatedCells: 0 });
    expect(result.structured).not.toHaveProperty("export");
  });
});

describe("mysql_query / doris_query 接入结果处理", () => {
  it("mysql_query 应用 columns 与 max_cell_width", async () => {
    const ctx = makeContext({
      connections: { main: { type: "mysql", host: "h", user: "ro" } },
    });
    (ctx.connections as unknown as { mysqlPool: () => unknown }).mysqlPool = () => fakePool(rows);

    const result = await mysqlQueryTool.handler(
      {
        connection: "main",
        sql: "SELECT id, name FROM t",
        columns: ["name"],
        max_cell_width: 20,
      },
      ctx,
    );
    expect(result.structured).toMatchObject({ columns: ["name"], truncatedCells: 1 });
    expect(result.text).not.toContain('"id"');
  });

  it("doris_query 支持强制落文件", async () => {
    const ctx = makeContext({
      connections: { dw: { type: "doris", host: "h", user: "ro" } },
    });
    (ctx.connections as unknown as { dorisPool: () => unknown }).dorisPool = () =>
      fakePool(rows);

    const result = await dorisQueryTool.handler(
      { connection: "dw", sql: "SELECT id, name FROM t", output: "file" },
      ctx,
    );
    const structured = result.structured as {
      preview: Array<Record<string, unknown>>;
      export: { format: string; rowCount: number };
    };
    expect(structured.export).toMatchObject({ format: "jsonl", rowCount: 2 });
    expect(structured.preview).toHaveLength(2);
    expect(result.summary).toContain("exported jsonl");
  });
});
