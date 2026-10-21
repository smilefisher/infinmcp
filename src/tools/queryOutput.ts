import {
  collectColumns,
  estimateRowsBytes,
  formatBytes,
  projectRows,
  shouldWriteFile,
  truncateRows,
  writeExport,
  type ExportFormat,
  type OutputMode,
  type Row,
} from "../output.js";
import type { ToolContext, ToolResult } from "./types.js";

/** 落文件时只把前 N 行放进上下文。 */
const PREVIEW_ROWS = 20;

export interface RowsResultOptions {
  ctx: ToolContext;
  /** 原始工具参数（读取 columns / max_cell_width / output / format）。 */
  args: Record<string, unknown>;
  connection: string;
  /** 导出文件名前缀（通常为连接名，会做 ASCII 清洗）。 */
  prefix: string;
  /** 已经拼好的 header（连接、行数等，不含列名）。 */
  header: string;
  /** 结果自带的列顺序（SQL 用 result.columns）；不传则取所有行键的并集。 */
  availableColumns?: string[];
  rows: Row[];
  rowCount: number;
  /** 数据库层面是否因 maxRows 截断。 */
  truncated: boolean;
  /** 日志摘要前缀，例如 `mysql_query on main`。 */
  summaryPrefix: string;
  /** 是否在 header 后追加「列: ...」（SQL 行结果用）。 */
  showColumns?: boolean;
  /** 结构化结果里完整行数组的键，默认 "rows"（Mongo 用 "documents"）。 */
  rowsKey?: string;
  /** 落文件时结构化结果里预览数组的键，默认 "preview"（Mongo 用 "documentsPreview"）。 */
  previewKey?: string;
}

function parseColumns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("columns 必须是字符串数组");
  }
  return value as string[];
}

function parseMode(value: unknown): OutputMode {
  if (value === "inline" || value === "file") return value;
  return "auto";
}

function parseFormat(value: unknown): ExportFormat {
  return value === "csv" ? "csv" : "jsonl";
}

function withCellInfo(header: string, truncatedCells: number, label = "截断单元格"): string {
  return truncatedCells > 0 ? `${header}\n${label}: ${truncatedCells}` : header;
}

/**
 * 查询行结果的统一出口：
 * 1. columns 列裁剪（不存在则报错）；
 * 2. max_cell_width 截断；
 * 3. 按 output / 阈值决定 inline 还是落文件；
 * 4. 落文件时 structuredContent 只给前 20 行预览 + 导出元信息。
 */
export function formatRowsResult(options: RowsResultOptions): ToolResult {
  const { ctx, args } = options;
  const limits = ctx.config.limits;
  const rowsKey = options.rowsKey ?? "rows";
  const previewKey = options.previewKey ?? "preview";

  const columns = parseColumns(args.columns);
  const maxCellWidth =
    typeof args.max_cell_width === "number" && Number.isFinite(args.max_cell_width)
      ? Math.trunc(args.max_cell_width)
      : limits.maxCellWidth;
  const mode = parseMode(args.output);
  const format = parseFormat(args.format);

  const availableColumns = options.availableColumns ?? collectColumns(options.rows);
  const projected = projectRows(options.rows, columns, availableColumns);

  if (projected.missing.length > 0) {
    const available = availableColumns.length > 0 ? availableColumns.join(", ") : "(无)";
    throw new Error(
      `columns 中包含结果里不存在的列: ${projected.missing.join(", ")}；可用列: ${available}`,
    );
  }

  const header = [
    options.header,
    ...(options.showColumns === false
      ? []
      : [`列: ${projected.columns.join(", ") || "(无)"}`]),
  ].join("\n");

  const bytes = estimateRowsBytes(projected.rows);

  if (shouldWriteFile(mode, projected.rows.length, bytes, limits)) {
    // 文件保留完整值；只有上下文里的预览按 max_cell_width 截断。
    const exported = writeExport(ctx.config.dataDir, projected.rows, {
      format,
      prefix: options.prefix,
      columns: projected.columns,
      limits,
    });
    const preview = truncateRows(projected.rows.slice(0, PREVIEW_ROWS), maxCellWidth);
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

    const text = [
      withCellInfo(header, preview.truncatedCells, "预览截断单元格"),
      "",
      `已导出 ${exported.rowCount} 行到文件（${format}，${formatBytes(exported.bytes)}）：`,
      `- 服务端路径: ${exported.path}`,
      ...downloadLines,
      "",
      `预览（前 ${preview.rows.length} 行）：`,
      JSON.stringify(preview.rows, null, 2),
    ].join("\n");

    return {
      text,
      structured: {
        columns: projected.columns,
        [previewKey]: preview.rows,
        previewRowCount: preview.rows.length,
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

  const inline = truncateRows(projected.rows, maxCellWidth);
  return {
    text: `${withCellInfo(header, inline.truncatedCells)}\n\n${JSON.stringify(inline.rows, null, 2)}`,
    structured: {
      columns: projected.columns,
      [rowsKey]: inline.rows,
      rowCount: options.rowCount,
      truncated: options.truncated,
      truncatedCells: inline.truncatedCells,
    },
    connection: options.connection,
    rowCount: options.rowCount,
    summary: `${options.summaryPrefix} (${options.rowCount} rows${options.truncated ? ", truncated" : ""})`,
  };
}
