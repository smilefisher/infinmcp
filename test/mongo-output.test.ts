import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { mongoAggregateTool, mongoFindTool } from "../src/tools/mongodb.js";
import type { ToolContext } from "../src/tools/types.js";

vi.mock("../src/connections/mongodb.js", () => ({
  mongoFind: vi.fn(async () => ({
    documents: [
      { _id: "1", name: "n".repeat(60), age: 20 },
      { _id: "2", name: "short", age: 30 },
    ],
    rowCount: 2,
    truncated: false,
  })),
  mongoAggregate: vi.fn(async () => ({
    documents: [{ _id: "1", total: 3 }],
    rowCount: 1,
    truncated: false,
  })),
  mongoListCollections: vi.fn(),
  mongoSchema: vi.fn(),
}));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-mongo-out-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeContext(): ToolContext {
  const connections: Record<string, ConnectionConfig> = {
    docs: { type: "mongodb", uri: "mongodb://example", database: "app" },
  };
  const ctx: ToolContext = {
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
  (ctx.connections as unknown as { mongoClient: () => unknown }).mongoClient = () => ({});
  return ctx;
}

describe("mongo_find / mongo_aggregate 接入结果处理", () => {
  it("columns 裁剪顶层字段 + max_cell_width 截断，保留 documents 键", async () => {
    const result = await mongoFindTool.handler(
      { connection: "docs", collection: "users", columns: ["name"], max_cell_width: 20 },
      makeContext(),
    );
    const structured = result.structured as {
      documents: Array<Record<string, unknown>>;
      columns: string[];
      truncatedCells: number;
    };
    expect(structured.columns).toEqual(["name"]);
    expect(structured.documents).toHaveLength(2);
    expect(structured.documents[0]).not.toHaveProperty("_id");
    expect(String(structured.documents[0]!.name)).toContain("已截断");
    expect(structured.truncatedCells).toBe(1);
    expect(result.text).not.toContain("_id");
    expect(result.text).not.toContain("列:");
  });

  it("output=file 时只给 documentsPreview 与导出元信息", async () => {
    const result = await mongoFindTool.handler(
      { connection: "docs", collection: "users", output: "file", format: "jsonl" },
      makeContext(),
    );
    const structured = result.structured as {
      documents?: unknown;
      documentsPreview: Array<Record<string, unknown>>;
      export: { file: string; rowCount: number };
    };
    expect(structured.documents).toBeUndefined();
    expect(structured.documentsPreview).toHaveLength(2);
    expect(structured.export.rowCount).toBe(2);
    expect(existsSync(join(dataDir, "exports", structured.export.file))).toBe(true);
    expect(result.text).toContain("已导出 2 行");
    expect(result.text).toContain("预览（前 2 行）");
  });

  it("columns 请求不存在的字段时报错并列出可用字段", async () => {
    await expect(
      mongoFindTool.handler(
        { connection: "docs", collection: "users", columns: ["nope"] },
        makeContext(),
      ),
    ).rejects.toThrow(/不存在的列: nope.*可用列: _id, name, age/);
  });

  it("mongo_aggregate 同样支持 columns 与文档键", async () => {
    const result = await mongoAggregateTool.handler(
      { connection: "docs", collection: "users", pipeline: [{ $match: {} }], columns: ["total"] },
      makeContext(),
    );
    const structured = result.structured as {
      documents: Array<Record<string, unknown>>;
      columns: string[];
    };
    expect(structured.columns).toEqual(["total"]);
    expect(structured.documents).toEqual([{ total: 3 }]);
  });
});
