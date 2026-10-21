import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupExports,
  csvCell,
  estimateRowsBytes,
  exportsDir,
  formatBytes,
  processRows,
  projectRows,
  sanitizeExportPrefix,
  serializeCsv,
  serializeJsonl,
  shouldWriteFile,
  truncateCell,
  writeExport,
} from "../src/output.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-output-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("truncateCell", () => {
  it("短字符串 / 短对象原样保留", () => {
    expect(truncateCell("short", 10)).toEqual({ value: "short", truncated: false });
    expect(truncateCell({ a: 1 }, 100)).toEqual({ value: { a: 1 }, truncated: false });
    expect(truncateCell(42, 1)).toEqual({ value: 42, truncated: false });
  });

  it("长字符串截断并标注原长", () => {
    const result = truncateCell("x".repeat(20), 5);
    expect(result.truncated).toBe(true);
    expect(String(result.value).startsWith("xxxxx")).toBe(true);
    expect(String(result.value)).toContain("已截断");
    expect(String(result.value)).toContain("20 字符");
  });

  it("长对象降级为截断后的 JSON 字符串", () => {
    const result = truncateCell({ text: "y".repeat(100) }, 20);
    expect(result.truncated).toBe(true);
    expect(typeof result.value).toBe("string");
    expect(String(result.value)).toContain("已截断");
  });

  it("Buffer 按 UTF-8 文本截断", () => {
    const result = truncateCell(Buffer.from("z".repeat(20)), 4);
    expect(result.truncated).toBe(true);
    expect(String(result.value).startsWith("zzzz")).toBe(true);
  });

  it("按 code point 计数（中文 / emoji 不被 UTF-16 长度误判）", () => {
    expect(truncateCell("中文中文", 4).truncated).toBe(false);
    expect(truncateCell("😀😀😀", 3).truncated).toBe(false);
    expect(truncateCell("中文中文", 3).truncated).toBe(true);
  });

  it("maxWidth <= 0 表示不截断", () => {
    expect(truncateCell("x".repeat(100), 0).truncated).toBe(false);
  });
});

describe("projectRows / processRows", () => {
  const rows = [
    { id: 1, name: "a", extra: true },
    { id: 2, name: "b", extra: false },
  ];

  it("按请求顺序裁剪列", () => {
    const result = projectRows(rows, ["name", "id"]);
    expect(result.columns).toEqual(["name", "id"]);
    expect(result.rows).toEqual([
      { name: "a", id: 1 },
      { name: "b", id: 2 },
    ]);
    expect(result.missing).toEqual([]);
  });

  it("缺失列通过 missing 返回，行里不出现该列", () => {
    const result = projectRows(rows, ["id", "nope"]);
    expect(result.columns).toEqual(["id"]);
    expect(result.missing).toEqual(["nope"]);
    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("不传 columns 时保留全部列（按首次出现顺序）", () => {
    const result = projectRows(rows);
    expect(result.columns).toEqual(["id", "name", "extra"]);
    expect(result.rows).toBe(rows);
  });

  it("processRows 先裁剪再截断，并统计截断单元格数", () => {
    const result = processRows([{ a: "x".repeat(10), b: 1, c: "drop" }], {
      columns: ["a", "b"],
      maxCellWidth: 4,
    });
    expect(result.columns).toEqual(["a", "b"]);
    expect(result.truncatedCells).toBe(1);
    expect(String(result.rows[0]!.a)).toContain("已截断");
    expect(result.rows[0]!.b).toBe(1);
    expect(result.rows[0]!.c).toBeUndefined();
  });
});

describe("序列化", () => {
  it("CSV 按 RFC 4180 转义逗号 / 引号 / 换行，null 为空", () => {
    expect(
      serializeCsv([{ a: 1, b: "x,y", c: 'q"q', d: "l1\nl2", e: null }], ["a", "b", "c", "d", "e"]),
    ).toBe('a,b,c,d,e\n1,"x,y","q""q","l1\nl2",\n');
  });

  it("CSV 单元格：对象转 JSON，日期转 ISO，ObjectId 取 hex", () => {
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(new Date("2020-01-01T00:00:00Z"))).toBe("2020-01-01T00:00:00.000Z");
    expect(csvCell({ toHexString: () => "abc123" })).toBe("abc123");
    expect(csvCell(undefined)).toBe("");
  });

  it("CSV 空结果 / 只有列头", () => {
    expect(serializeCsv([])).toBe("");
    expect(serializeCsv([], ["a", "b"])).toBe("a,b\n");
  });

  it("JSONL 每行一个对象，末尾换行", () => {
    expect(serializeJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
    expect(serializeJsonl([])).toBe("");
    expect(serializeJsonl([{ b: 2, a: 1 }], ["a", "b"])).toBe('{"a":1,"b":2}\n');
  });

  it("estimateRowsBytes 按 UTF-8 字节估算", () => {
    expect(estimateRowsBytes([{ a: "中" }])).toBeGreaterThan(estimateRowsBytes([{ a: "a" }]));
    expect(estimateRowsBytes([])).toBe(2); // "[]"
  });

  it("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MiB");
  });
});

describe("shouldWriteFile", () => {
  const limits = { inlineMaxBytes: 100, inlineMaxRows: 2 };

  it("auto 按行数或字节数判断", () => {
    expect(shouldWriteFile("auto", 2, 50, limits)).toBe(false);
    expect(shouldWriteFile("auto", 3, 50, limits)).toBe(true);
    expect(shouldWriteFile("auto", 2, 101, limits)).toBe(true);
  });

  it("inline / file 强制覆盖阈值", () => {
    expect(shouldWriteFile("inline", 999, 10 ** 9, limits)).toBe(false);
    expect(shouldWriteFile("file", 0, 0, limits)).toBe(true);
  });
});

describe("导出文件名与落盘", () => {
  it("中文前缀清洗为 ASCII，非法字符替换为 -", () => {
    expect(sanitizeExportPrefix("测试 db")).toBe("db");
    expect(sanitizeExportPrefix("a/b c")).toBe("a-b-c");
    expect(sanitizeExportPrefix("")).toBe("export");
    expect(sanitizeExportPrefix(undefined)).toBe("export");
  });

  it("CSV 落盘：目录 0700、文件 0600、带 BOM、文件名 ASCII", () => {
    const info = writeExport(dataDir, [{ a: 1 }, { a: 2 }], {
      format: "csv",
      prefix: "测试 db",
      limits: { exportTtlHours: 24, exportMaxFiles: 200 },
    });

    expect(info.file).toMatch(/^db-\d{14}-[0-9a-f]{8}\.csv$/);
    expect(info.file).not.toMatch(/[^\x20-\x7E]/);
    expect(statSync(exportsDir(dataDir)).mode & 0o777).toBe(0o700);
    expect(statSync(info.path).mode & 0o777).toBe(0o600);
    expect(info.bytes).toBeGreaterThan(0);
    expect(info.rowCount).toBe(2);
    expect(readFileSync(info.path, "utf8")).toBe("\uFEFFa\n1\n2\n");
  });

  it("JSONL 落盘与列顺序", () => {
    const info = writeExport(dataDir, [{ b: 2, a: 1 }], {
      format: "jsonl",
      prefix: "main",
      columns: ["a", "b"],
      limits: { exportTtlHours: 24, exportMaxFiles: 200 },
    });
    expect(info.file).toMatch(/^main-.*\.jsonl$/);
    expect(readFileSync(info.path, "utf8")).toBe('{"a":1,"b":2}\n');
  });

  it("清理过期与超量文件，不动非导出文件", () => {
    const dir = exportsDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const make = (name: string, ageHours: number) => {
      const path = join(dir, name);
      writeFileSync(path, "x");
      const time = new Date(now - ageHours * 3600_000);
      utimesSync(path, time, time);
    };
    make("expired-1.jsonl", 25);
    make("expired-2.csv", 30);
    make("fresh-1.jsonl", 1);
    make("fresh-2.jsonl", 2);
    make("fresh-3.jsonl", 3);
    writeFileSync(join(dir, "keep.txt"), "x");

    const result = cleanupExports(dataDir, { exportTtlHours: 24, exportMaxFiles: 2 }, now);
    expect(readdirSync(dir).sort()).toEqual(["fresh-1.jsonl", "fresh-2.jsonl", "keep.txt"]);
    expect(result.removed.sort()).toEqual(["expired-1.jsonl", "expired-2.csv", "fresh-3.jsonl"].sort());
  });
});
