import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 查询结果的后处理：长文本 / 长 JSON 截断、列裁剪、CSV / JSONL 序列化、大结果落文件。
 *
 * 这里只做通用能力，不包含任何业务口径（不按表名 / 字段名做特殊处理）。
 */

export type Row = Record<string, unknown>;
export type OutputMode = "auto" | "inline" | "file";
export type ExportFormat = "jsonl" | "csv";

/** 与 config.ts 的 limits 对齐（只取输出相关字段，便于单测直接构造）。 */
export interface OutputLimits {
  maxCellWidth: number;
  inlineMaxBytes: number;
  inlineMaxRows: number;
  exportTtlHours: number;
  exportMaxFiles: number;
}

export interface ProcessOptions {
  /** 只保留这些列（按给定顺序）；不传表示保留全部。 */
  columns?: string[];
  /** 单元格最大字符数；<=0 表示不截断。 */
  maxCellWidth?: number;
  /** 结果自带的列顺序（SQL 用 result.columns）；不传则取所有行键的并集。 */
  availableColumns?: string[];
}

export interface ProcessResult {
  rows: Row[];
  columns: string[];
  /** 被截断的单元格数量。 */
  truncatedCells: number;
  /** 请求了但结果里不存在的列。 */
  missingColumns: string[];
}

/** 用 code point 计数，避免中文 / emoji 被按 UTF-16 长度误判。 */
function textLength(text: string): number {
  return Array.from(text).length;
}

function sliceText(text: string, maxWidth: number): string {
  return Array.from(text).slice(0, maxWidth).join("");
}

function truncationMarker(originalLength: number): string {
  return `…（已截断，原长 ${originalLength} 字符）`;
}

/**
 * 截断单个单元格：
 * - 字符串按字符数截断；
 * - Buffer 先按 UTF-8 转文本再截断；
 * - 对象 / 数组先 JSON 序列化，只有序列化后超长才降级为截断后的字符串（短对象保持原结构）。
 */
export function truncateCell(value: unknown, maxWidth: number): { value: unknown; truncated: boolean } {
  if (maxWidth <= 0) return { value, truncated: false };

  if (typeof value === "string") {
    if (value.length <= maxWidth) return { value, truncated: false };
    const length = textLength(value);
    if (length <= maxWidth) return { value, truncated: false };
    return { value: `${sliceText(value, maxWidth)}${truncationMarker(length)}`, truncated: true };
  }

  if (Buffer.isBuffer(value)) {
    const text = value.toString("utf8");
    const result = truncateCell(text, maxWidth);
    return { value: result.value, truncated: result.truncated };
  }

  if (value !== null && typeof value === "object") {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      return { value: "[无法序列化]", truncated: true };
    }
    if (json === undefined) return { value, truncated: false };
    if (json.length <= maxWidth) return { value, truncated: false };
    const length = textLength(json);
    if (length <= maxWidth) return { value, truncated: false };
    return { value: `${sliceText(json, maxWidth)}${truncationMarker(length)}`, truncated: true };
  }

  return { value, truncated: false };
}

/** 收集所有行出现过的键（保持首次出现顺序）。 */
export function collectColumns(rows: Row[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  return columns;
}

/**
 * 列裁剪：按请求顺序输出，缺失列通过 `missing` 返回（由调用方决定是否报错）。
 * 不传 `columns` 时保留全部列。
 */
export function projectRows(
  rows: Row[],
  columns?: string[],
  availableColumns?: string[],
): { rows: Row[]; columns: string[]; missing: string[] } {
  const available = availableColumns ?? collectColumns(rows);
  if (!columns || columns.length === 0) {
    return { rows, columns: available, missing: [] };
  }

  const availableSet = new Set(available);
  const missing = columns.filter((column) => !availableSet.has(column));
  const selected = columns.filter((column) => availableSet.has(column));

  return {
    rows: rows.map((row) => {
      const out: Row = {};
      for (const column of selected) {
        out[column] = row[column] ?? null;
      }
      return out;
    }),
    columns: selected,
    missing,
  };
}

/** 只做截断（不改列），便于「完整落文件 + 截断预览」共用。 */
export function truncateRows(rows: Row[], maxWidth: number): { rows: Row[]; truncatedCells: number } {
  if (maxWidth <= 0) return { rows, truncatedCells: 0 };

  let truncatedCells = 0;
  const out = rows.map((row) => {
    const next: Row = {};
    for (const [key, value] of Object.entries(row)) {
      const cell = truncateCell(value, maxWidth);
      if (cell.truncated) truncatedCells += 1;
      next[key] = cell.value;
    }
    return next;
  });
  return { rows: out, truncatedCells };
}

/** 先做列裁剪，再按 `maxCellWidth` 截断（用于直接返回 / 预览；导出文件可保留完整值）。 */
export function processRows(rows: Row[], options: ProcessOptions = {}): ProcessResult {
  const projected = projectRows(rows, options.columns, options.availableColumns);
  const truncated = truncateRows(projected.rows, options.maxCellWidth ?? 0);

  return {
    rows: truncated.rows,
    columns: projected.columns,
    truncatedCells: truncated.truncatedCells,
    missingColumns: projected.missing,
  };
}

/** JSON.stringify 的 BigInt 兜底（MySQL 大整数一般已是字符串，这里只防御）。 */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function serializeRow(row: Row): string {
  return JSON.stringify(row, jsonReplacer) ?? "{}";
}

/** CSV 单元格：引号 / 逗号 / 换行时按 RFC 4180 转义。 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    text = String(value);
  } else if (value instanceof Date) {
    text = value.toISOString();
  } else if (Buffer.isBuffer(value)) {
    text = value.toString("base64");
  } else if (typeof (value as { toHexString?: unknown }).toHexString === "function") {
    // MongoDB ObjectId
    text = (value as { toHexString: () => string }).toHexString();
  } else {
    try {
      text = JSON.stringify(value, jsonReplacer) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 序列化为 CSV（不含 BOM；写文件时由 writeExport 补 BOM，方便 Excel 打开中文）。 */
export function serializeCsv(rows: Row[], columns?: string[]): string {
  const cols = columns && columns.length > 0 ? columns : collectColumns(rows);
  if (cols.length === 0) return "";
  const lines = [cols.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(cols.map((column) => csvCell(row[column])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** 序列化为 JSONL（每行一个 JSON 对象）；提供 columns 时按其顺序输出并补齐缺失列为 null。 */
export function serializeJsonl(rows: Row[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const lines = rows.map((row) => {
    if (!columns || columns.length === 0) return serializeRow(row);
    const out: Row = {};
    for (const column of columns) out[column] = row[column] ?? null;
    return serializeRow(out);
  });
  return `${lines.join("\n")}\n`;
}

/** 估算结构化结果的 JSON 字节数（用于 auto 模式判断是否落文件）。 */
export function estimateRowsBytes(rows: Row[]): number {
  return Buffer.byteLength(JSON.stringify(rows, jsonReplacer) ?? "[]", "utf8");
}

/** 是否超过 inline（直接进上下文）的阈值。 */
export function exceedsInlineLimits(
  rowCount: number,
  bytes: number,
  limits: Pick<OutputLimits, "inlineMaxBytes" | "inlineMaxRows">,
): boolean {
  return rowCount > limits.inlineMaxRows || bytes > limits.inlineMaxBytes;
}

/** auto：超过阈值才落文件；file：强制落文件；inline：永不落文件。 */
export function shouldWriteFile(
  mode: OutputMode,
  rowCount: number,
  bytes: number,
  limits: Pick<OutputLimits, "inlineMaxBytes" | "inlineMaxRows">,
): boolean {
  if (mode === "file") return true;
  if (mode === "inline") return false;
  return exceedsInlineLimits(rowCount, bytes, limits);
}

export function exportsDir(dataDir: string): string {
  return join(dataDir, "exports");
}

/** 文件名前缀做 ASCII 清洗（中文连接名不直接进文件名）。 */
export function sanitizeExportPrefix(prefix: string | undefined): string {
  const ascii = (prefix ?? "").replace(/[^\x20-\x7E]/g, "");
  const cleaned = ascii
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 40);
  return cleaned || "export";
}

function timestamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "").replace("T", "-").replace(/[-:]/g, "");
}

function makeExportFileName(prefix: string | undefined, format: ExportFormat, now: Date): string {
  return `${sanitizeExportPrefix(prefix)}-${timestamp(now)}-${randomBytes(4).toString("hex")}.${format}`;
}

export interface CleanupResult {
  removed: string[];
}

/**
 * 清理导出目录：
 * 1. 删除超过 `exportTtlHours` 的文件；
 * 2. 若仍超过 `exportMaxFiles`，按 mtime 从旧到新删除。
 * 只处理 `.jsonl` / `.csv`，不动目录里的其它文件。
 */
export function cleanupExports(
  dataDir: string,
  limits: Pick<OutputLimits, "exportTtlHours" | "exportMaxFiles">,
  now: number = Date.now(),
): CleanupResult {
  const dir = exportsDir(dataDir);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { removed: [] };
  }

  const files = entries
    .filter((entry) => entry.isFile() && /\.(jsonl|csv)$/.test(entry.name))
    .map((entry) => {
      const path = join(dir, entry.name);
      let mtime = 0;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { name: entry.name, path, mtime };
    });

  const removed: string[] = [];
  const remove = (path: string, name: string): void => {
    try {
      unlinkSync(path);
      removed.push(name);
    } catch {
      // 文件可能已被并发删除；忽略。
    }
  };

  const ttlMs = limits.exportTtlHours * 3600_000;
  const kept = files.filter((file) => {
    if (now - file.mtime > ttlMs) {
      remove(file.path, file.name);
      return false;
    }
    return true;
  });

  if (kept.length > limits.exportMaxFiles) {
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const file of kept.slice(0, kept.length - limits.exportMaxFiles)) {
      remove(file.path, file.name);
    }
  }

  return { removed };
}

export interface ExportFileInfo {
  /** 导出目录内的文件名（ASCII，可直接拼到 /api/exports/ 后）。 */
  file: string;
  /** 服务端绝对路径。 */
  path: string;
  format: ExportFormat;
  /** 文件字节数（CSV 含 BOM）。 */
  bytes: number;
  rowCount: number;
  /** ISO 时间。 */
  createdAt: string;
}

export interface WriteExportOptions {
  format?: ExportFormat;
  /** 文件名前缀（通常传连接名）；会被清洗为 ASCII。 */
  prefix?: string;
  /** CSV 的列顺序；缺省取所有行键并集。 */
  columns?: string[];
  limits: Pick<OutputLimits, "exportTtlHours" | "exportMaxFiles">;
  now?: Date;
}

/** 把行结果写成 CSV / JSONL 到 `<data-dir>/exports/`，并顺手清理过期文件。 */
export function writeExport(dataDir: string, rows: Row[], options: WriteExportOptions): ExportFileInfo {
  const format = options.format ?? "jsonl";
  const dir = exportsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 目录可能由其它进程创建；权限清理失败不阻塞导出。
  }

  const content =
    format === "csv"
      ? `\uFEFF${serializeCsv(rows, options.columns)}`
      : serializeJsonl(rows, options.columns);
  const buffer = Buffer.from(content, "utf8");

  const now = options.now ?? new Date();
  let file = makeExportFileName(options.prefix, format, now);
  for (let attempt = 0; attempt < 5 && existsSync(join(dir, file)); attempt += 1) {
    file = makeExportFileName(options.prefix, format, now);
  }
  const path = join(dir, file);
  writeFileSync(path, buffer, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // 同上，忽略权限设置失败。
  }

  // 写入后再清理，保证文件总数（含刚写入的文件）不超过上限。
  cleanupExports(dataDir, options.limits, now.getTime());

  return {
    file,
    path,
    format,
    bytes: buffer.byteLength,
    rowCount: rows.length,
    createdAt: now.toISOString(),
  };
}

/** 人类可读的字节数（用于工具文本输出）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
