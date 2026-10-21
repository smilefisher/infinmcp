import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { redisExecTool, redisScanTool } from "../src/tools/redis.js";
import { formatValueResult } from "../src/tools/valueOutput.js";
import type { ToolContext } from "../src/tools/types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-value-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function makeContext(
  connections: Record<string, ConnectionConfig> = {},
  limits: Partial<LoadedConfig["limits"]> = {},
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
        ...limits,
      },
    } as unknown as LoadedConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    connections: new ConnectionManager({ connections, timeoutMs: 1000 }),
    user: "tester",
  };
}

function fakeRedis(reply: unknown) {
  return { status: "ready", call: async () => reply };
}

function useRedisClient(ctx: ToolContext, client: unknown): void {
  (ctx.connections as unknown as { redisClient: () => unknown }).redisClient = () => client;
}

describe("formatValueResult", () => {
  it("标量长文本按 max_cell_width 截断并保留原结构", () => {
    const result = formatValueResult({
      ctx: makeContext(),
      args: { max_cell_width: 20 },
      connection: "cache",
      prefix: "cache",
      header: "连接: cache\n命令: GET k",
      value: "x".repeat(100),
      rowCount: 1,
      truncated: false,
      summaryPrefix: "redis_exec GET on cache",
    });
    const structured = result.structured as { value: string; truncatedCells: number };
    expect(structured.truncatedCells).toBe(1);
    expect(structured.value).toContain("已截断");
    expect(result.text).toContain("截断项: 1");
    expect(result.summary).toBe("redis_exec GET on cache (1 rows)");
  });

  it("数组逐项截断，不把整个数组压成字符串", () => {
    const result = formatValueResult({
      ctx: makeContext(),
      args: { max_cell_width: 20 },
      connection: "cache",
      prefix: "cache",
      header: "连接: cache",
      value: ["a".repeat(60), "short"],
      rowCount: 2,
      truncated: false,
      summaryPrefix: "redis_exec LRANGE on cache",
    });
    const structured = result.structured as { value: unknown[]; truncatedCells: number };
    expect(Array.isArray(structured.value)).toBe(true);
    expect(structured.value).toHaveLength(2);
    expect(String(structured.value[0])).toContain("已截断");
    expect(structured.value[1]).toBe("short");
    expect(structured.truncatedCells).toBe(1);
  });

  it("output=file 时只给前 20 项预览，文件写完整值", () => {
    const keys = Array.from({ length: 25 }, (_, index) => `key-${"a".repeat(40)}-${index}`);
    const result = formatValueResult({
      ctx: makeContext({}, { inlineMaxRows: 1000 }),
      args: { output: "file", format: "csv", max_cell_width: 20 },
      connection: "cache",
      prefix: "cache-scan",
      header: "连接: cache\ncursor: 42\n本批 key 数: 25",
      value: keys,
      rowCount: 25,
      truncated: false,
      summaryPrefix: "redis_scan on cache",
      valueKey: "keys",
      extraStructured: { cursor: "42", count: 25 },
    });

    const structured = result.structured as {
      keys: string[];
      previewCount: number;
      cursor: string;
      count: number;
      export: { file: string; rowCount: number; format: string };
    };
    expect(structured.keys).toHaveLength(20);
    expect(structured.previewCount).toBe(20);
    expect(structured.cursor).toBe("42");
    expect(structured.count).toBe(25);
    expect(structured.export).toMatchObject({ rowCount: 25, format: "csv" });
    expect(existsSync(join(dataDir, "exports", structured.export.file))).toBe(true);
    expect(readFileSync(join(dataDir, "exports", structured.export.file), "utf8")).toContain(
      "a".repeat(40),
    );
    expect(result.text).toContain("预览（前 20 项）");
    expect(result.text).toContain("已导出 25 行");
  });

  it("auto 超过 inlineMaxRows 时落文件", () => {
    const result = formatValueResult({
      ctx: makeContext({}, { inlineMaxRows: 2 }),
      args: {},
      connection: "cache",
      prefix: "cache",
      header: "连接: cache",
      value: ["a", "b", "c"],
      rowCount: 3,
      truncated: false,
      summaryPrefix: "redis_exec MGET on cache",
    });
    const structured = result.structured as { export?: { rowCount: number } };
    expect(structured.export?.rowCount).toBe(3);
    expect(result.summary).toContain("exported jsonl");
  });

  it("标量对象按字段截断", () => {
    const result = formatValueResult({
      ctx: makeContext(),
      args: { max_cell_width: 20 },
      connection: "cache",
      prefix: "cache",
      header: "连接: cache",
      value: { short: "ok", long: "z".repeat(100) },
      rowCount: 1,
      truncated: false,
      summaryPrefix: "redis_exec HGETALL on cache",
    });
    const structured = result.structured as {
      value: { short: string; long: string };
      truncatedCells: number;
    };
    expect(structured.value.short).toBe("ok");
    expect(structured.value.long).toContain("已截断");
    expect(structured.truncatedCells).toBe(1);
  });
});

describe("redis_exec / redis_scan 接入结果处理", () => {
  it("redis_exec 返回截断后的 GET 值", async () => {
    const ctx = makeContext({ cache: { type: "redis", host: "h" } });
    useRedisClient(ctx, fakeRedis("v".repeat(80)));

    const result = await redisExecTool.handler(
      { connection: "cache", command: "GET", args: ["k"], max_cell_width: 20 },
      ctx,
    );
    const structured = result.structured as { value: string; truncatedCells: number };
    expect(structured.value).toContain("已截断");
    expect(structured.truncatedCells).toBe(1);
    expect(result.text).toContain("命令: GET k");
  });

  it("redis_scan 落文件时保留 cursor 与完整 key 数", async () => {
    const keys = Array.from({ length: 25 }, (_, index) => `user:${"b".repeat(40)}:${index}`);
    const ctx = makeContext({ cache: { type: "redis", host: "h" } });
    useRedisClient(ctx, fakeRedis(["42", keys]));

    const result = await redisScanTool.handler(
      { connection: "cache", output: "file", format: "jsonl", max_cell_width: 20 },
      ctx,
    );
    const structured = result.structured as {
      cursor: string;
      count: number;
      keys: string[];
      export: { file: string; rowCount: number };
    };
    expect(structured.cursor).toBe("42");
    expect(structured.count).toBe(25);
    expect(structured.keys).toHaveLength(20);
    expect(structured.export.rowCount).toBe(25);
    expect(result.text).toContain("cursor: 42");
    expect(result.text).toContain("已导出 25 行");
  });
});
