import {
  formatBytes,
  shouldWriteFile,
  truncateCell,
  writeExport,
  type ExportFormat,
  type OutputMode,
  type Row,
} from "../output.js";
import type { ToolContext, ToolResult } from "./types.js";

/** 落文件时最多展示多少个数组元素 / 对象字段。 */
const PREVIEW_ITEMS = 20;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function parseMode(value: unknown): OutputMode {
  if (value === "inline" || value === "file") return value;
  return "auto";
}

function parseFormat(value: unknown): ExportFormat {
  return value === "csv" ? "csv" : "jsonl";
}

/**
 * 按单元格截断任意 Redis 值：
 * - 数组逐项截断；
 * - 对象逐字段截断；
 * - 标量当单值截断。
 * 这样短数组 / 短对象保持原结构，不会因为整体 JSON 超长被压成一个字符串。
 */
export function truncateValue(
  value: unknown,
  maxWidth: number,
): { value: unknown; truncatedCells: number } {
  if (maxWidth <= 0) return { value, truncatedCells: 0 };

  if (Array.isArray(value)) {
    let truncatedCells = 0;
    const out = value.map((item) => {
      const cell = truncateCell(item, maxWidth);
      if (cell.truncated) truncatedCells += 1;
      return cell.value;
    });
    return { value: out, truncatedCells };
  }

  if (isPlainObject(value)) {
    let truncatedCells = 0;
    const out: Row = {};
    for (const [key, item] of Object.entries(value)) {
      const cell = truncateCell(item, maxWidth);
      if (cell.truncated) truncatedCells += 1;
      out[key] = cell.value;
    }
    return { value: out, truncatedCells };
  }

  const cell = truncateCell(value, maxWidth);
  return { value: cell.value, truncatedCells: cell.truncated ? 1 : 0 };
}

/** 把非表格值转成导出用的行：数组按 index/value，对象按 key/value，标量单行。 */
export function valueToRows(value: unknown): Row[] {
  if (Array.isArray(value)) {
    return value.map((item, index) => ({ index, value: item }));
  }
  if (isPlainObject(value)) {
    return Object.entries(value).map(([key, item]) => ({ key, value: item }));
  }
  return [{ value }];
}

function valueBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
  } catch {
    return 0;
  }
}

function previewSource(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) return value.slice(0, limit);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, limit));
  }
  return value;
}

function countValue(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (isPlainObject(value)) return Object.keys(value).length;
  return 1;
}

function withValueInfo(header: string, count: number, label: string): string {
  return count > 0 ? `${header}\n${label}: ${count}` : header;
}

export interface ValueResultOptions {
  ctx: ToolContext;
  /** 原始工具参数（读取 max_cell_width / output / format）。 */
  args: Record<string, unknown>;
  connection: string;
  /** 导出文件名前缀（会做 ASCII 清洗）。 */
  prefix: string;
  /** 已经拼好的 header（连接、命令、结果条数等）。 */
  header: string;
  /** 原始结果值（数组 / 对象 / 标量）。 */
  value: unknown;
  /** 逻辑结果条数。 */
  rowCount: number;
  /** 数据库层面是否因 maxRows 截断。 */
  truncated: boolean;
  /** 日志摘要前缀。 */
  summaryPrefix: string;
  /** 结构化结果里承载值的键，默认 "value"（scan 用 "keys"）。 */
  valueKey?: string;
  /** 附加到 structuredContent 的字段（例如 Redis SCAN 的 cursor）。 */
  extraStructured?: Record<string, unknown>;
  /** 预览最多展示多少个元素 / 字段，默认 20。 */
  previewItems?: number;
}

/**
 * Redis 等「非表格值」的统一出口：
 * 1. 按 max_cell_width 截断长文本 / 长 JSON（数组逐项、对象逐字段）；
 * 2. 按 output / 阈值决定 inline 还是落文件；
 * 3. 落文件时写完整值，structuredContent 只给预览 + 导出元信息。
 */
export function formatValueResult(options: ValueResultOptions): ToolResult {
  const { ctx, args } = options;
  const limits = ctx.config.limits;
  const valueKey = options.valueKey ?? "value";
  const previewItems = options.previewItems ?? PREVIEW_ITEMS;

  const maxCellWidth =
    typeof args.max_cell_width === "number" && Number.isFinite(args.max_cell_width)
      ? Math.trunc(args.max_cell_width)
      : limits.maxCellWidth;
  const mode = parseMode(args.output);
  const format = parseFormat(args.format);

  if (shouldWriteFile(mode, options.rowCount, valueBytes(options.value), limits)) {
    // 文件写完整值；上下文里的预览才截断。
    const exported = writeExport(ctx.config.dataDir, valueToRows(options.value), {
      format,
      prefix: options.prefix,
      limits,
    });
    const source = previewSource(options.value, previewItems);
    const preview = truncateValue(source, maxCellWidth);
    const previewCount = countValue(source);
    const downloadPath = `/api/exports/${encodeURIComponent(exported.file)}`;
    const downloadUrl = ctx.publicBaseUrl
      ? new URL(downloadPath, ctx.publicBaseUrl).toString()
      : undefined;

    const downloadLines = downloadUrl
      ? [`- 下载: ${downloadUrl}`, "- 说明: 请求时携带当前 API Key（Authorization: Bearer ...）"]
      : [
          `- 下载路径: ${downloadPath}`,
          "- 说明: 通过 HTTP serve 访问时，用 GET 该路径并携带当前 API Key；stdio 模式可直接读服务端路径",
        ];

    return {
      text: [
        withValueInfo(options.header, preview.truncatedCells, "预览截断项"),
        "",
        `已导出 ${exported.rowCount} 行到文件（${format}，${formatBytes(exported.bytes)}）：`,
        `- 服务端路径: ${exported.path}`,
        ...downloadLines,
        "",
        `预览（前 ${previewCount} 项）：`,
        JSON.stringify(preview.value, null, 2),
      ].join("\n"),
      structured: {
        ...(options.extraStructured ?? {}),
        [valueKey]: preview.value,
        previewCount,
        rowCount: options.rowCount,
        truncated: options.truncated,
        truncatedCells: preview.truncatedCells,
        export: {
          file: exported.file,
          format: exported.format,
          bytes: exported.bytes,
          rowCount: exported.rowCount,
          createdAt: exported.createdAt,
          path: exported.path,
          downloadPath,
          ...(downloadUrl ? { downloadUrl } : {}),
        },
      },
      connection: options.connection,
      rowCount: options.rowCount,
      summary:
        `${options.summaryPrefix} (${options.rowCount} rows` +
        `${options.truncated ? ", truncated" : ""}, exported ${format})`,
    };
  }

  const inline = truncateValue(options.value, maxCellWidth);
  return {
    text: `${withValueInfo(options.header, inline.truncatedCells, "截断项")}\n\n${JSON.stringify(inline.value, null, 2)}`,
    structured: {
      ...(options.extraStructured ?? {}),
      [valueKey]: inline.value,
      rowCount: options.rowCount,
      truncated: options.truncated,
      truncatedCells: inline.truncatedCells,
    },
    connection: options.connection,
    rowCount: options.rowCount,
    summary: `${options.summaryPrefix} (${options.rowCount} rows${options.truncated ? ", truncated" : ""})`,
  };
}
