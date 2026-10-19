import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 一次工具调用的结构化日志（写入 JSONL，并推送给 Web 端）。 */
export interface ToolCallLog {
  /** ISO 时间戳。 */
  ts: string;
  /** 调用者：API Key 名称；stdio 模式下为 "local"。 */
  user: string;
  /** 工具名。 */
  tool: string;
  /** 目标连接名（若适用）。 */
  connection?: string;
  status: "ok" | "error";
  durationMs: number;
  /** 结果行数（若适用）。 */
  rowCount?: number;
  /** 请求的简短摘要（不含口令等敏感信息）。 */
  summary?: string;
  /** 失败时的错误信息。 */
  error?: string;
}

export interface LoggerOptions {
  /** JSONL 日志文件路径。 */
  file: string;
  /** 内存中保留的最近记录条数。 */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 1000;

/**
 * 工具调用日志：落盘 JSONL + 内存环形缓冲 + 订阅推送（供 Web SSE 使用）。
 * 只写文件与内存，绝不写 stdout —— stdio MCP 下 stdout 只允许协议数据。
 */
export class Logger {
  private readonly file: string;
  private readonly maxBuffer: number;
  private readonly buffer: ToolCallLog[] = [];
  private readonly listeners = new Set<(entry: ToolCallLog) => void>();

  constructor(options: LoggerOptions) {
    this.file = options.file;
    this.maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
    } catch (error) {
      diag("warn", `无法创建日志目录 ${dirname(this.file)}: ${(error as Error).message}`);
    }
  }

  /** 记录一次调用（自动补时间戳），返回完整记录。 */
  record(entry: Omit<ToolCallLog, "ts">): ToolCallLog {
    const full: ToolCallLog = { ts: new Date().toISOString(), ...entry };
    this.buffer.push(full);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.splice(0, this.buffer.length - this.maxBuffer);
    }
    try {
      appendFileSync(this.file, `${JSON.stringify(full)}\n`, "utf8");
    } catch (error) {
      diag("warn", `写入日志文件失败 ${this.file}: ${(error as Error).message}`);
    }
    for (const listener of this.listeners) {
      try {
        listener(full);
      } catch {
        // 单个订阅者异常不影响其它订阅者
      }
    }
    return full;
  }

  /** 最近的记录（时间升序）。 */
  recent(limit = 100): ToolCallLog[] {
    if (limit <= 0) return [];
    return this.buffer.slice(-limit);
  }

  /** 订阅新记录，返回取消订阅函数。 */
  subscribe(listener: (entry: ToolCallLog) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** 诊断信息统一走 stderr（避免污染 stdio 的 stdout 协议流）。 */
export function diag(level: "info" | "warn" | "error", message: string): void {
  process.stderr.write(`[infinmcp] ${level}: ${message}\n`);
}
