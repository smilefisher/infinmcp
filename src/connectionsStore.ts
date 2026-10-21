import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConnectionSchema, type ConnectionConfig } from "./config.js";

export const CONNECTIONS_FILE = "connections.json";

/** 连接配置的读写错误（HTTP 层映射为 400）。 */
export class ConnectionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionStoreError";
  }
}

/**
 * 连接名规则：中文 / 字母 / 数字 / 空格 / 下划线 / 点 / 连字符，最长 64。
 * 允许中文是为了让连接名本身能带业务可读的标签（例如「测试环境mysql」）。
 */
const NAME_RE = /^[\p{L}\p{N}_.\- ]{1,64}$/u;

export function assertValidConnectionName(name: string): void {
  const invalid = (): never => {
    throw new ConnectionStoreError(
      `连接名不合法: "${name}"（允许中文 / 字母 / 数字 / 空格 / 下划线 / 点 / 连字符，长度 1–64，` +
        "且不能以空格开头或结尾）",
    );
  };
  if (!NAME_RE.test(name)) invalid();
  if (name !== name.trim() || / {2,}/.test(name)) invalid();
}

export function connectionsFilePath(dataDir: string): string {
  return join(dataDir, CONNECTIONS_FILE);
}

/** 读取可写的 connections.json；文件不存在 / 损坏时返回空对象（不抛错，容错优先）。 */
export function readConnections(dataDir: string): Record<string, ConnectionConfig> {
  const file = connectionsFilePath(dataDir);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (text === "") return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const container = raw as { connections?: unknown } | null;
  const list = container?.connections;
  if (list === null || typeof list !== "object" || Array.isArray(list)) return {};

  const out: Record<string, ConnectionConfig> = {};
  for (const [name, value] of Object.entries(list as Record<string, unknown>)) {
    const parsed = ConnectionSchema.safeParse(value);
    if (parsed.success) out[name] = parsed.data;
  }
  return out;
}

/** 原子写入 connections.json（0600）。 */
export function writeConnections(dataDir: string, connections: Record<string, ConnectionConfig>): void {
  mkdirSync(dataDir, { recursive: true });
  const file = connectionsFilePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify({ connections }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

/** 省略口令字段时沿用旧值，避免前端必须回填密钥。 */
function inheritSecrets(
  incoming: Record<string, unknown>,
  existing: ConnectionConfig | undefined,
): Record<string, unknown> {
  if (!existing) return incoming;
  const out: Record<string, unknown> = { ...incoming };
  if (out.type === undefined) out.type = existing.type;

  if (existing.type === "mysql" && out.type === "mysql") {
    if (out.password === undefined || out.password === "") out.password = existing.password;
    if (out.user === undefined) out.user = existing.user;
    if (out.host === undefined) out.host = existing.host;
  }
  if (existing.type === "doris" && out.type === "doris") {
    if (out.password === undefined || out.password === "") out.password = existing.password;
    if (out.user === undefined) out.user = existing.user;
    if (out.host === undefined) out.host = existing.host;
  }
  if (existing.type === "redis" && out.type === "redis") {
    if (out.password === undefined || out.password === "") out.password = existing.password;
    if (out.username === undefined) out.username = existing.username;
    if (out.host === undefined) out.host = existing.host;
  }
  if (existing.type === "mongodb" && out.type === "mongodb") {
    if (out.uri === undefined || out.uri === "") out.uri = existing.uri;
  }
  return out;
}

function firstIssueMessage(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `  - ${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
}

/** 新增或更新一个连接并落盘；返回校验后的配置。 */
export function upsertConnection(dataDir: string, name: string, rawConfig: unknown): ConnectionConfig {
  assertValidConnectionName(name);
  if (rawConfig === null || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
    throw new ConnectionStoreError("连接配置必须是 JSON 对象");
  }

  const connections = readConnections(dataDir);
  const merged = inheritSecrets(rawConfig as Record<string, unknown>, connections[name]);
  const parsed = ConnectionSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConnectionStoreError(`连接配置校验失败:\n${firstIssueMessage(parsed.error)}`);
  }

  connections[name] = parsed.data;
  writeConnections(dataDir, connections);
  return parsed.data;
}

/** 删除一个连接；返回是否确有删除。 */
export function deleteConnection(dataDir: string, name: string): boolean {
  const connections = readConnections(dataDir);
  if (!Object.prototype.hasOwnProperty.call(connections, name)) return false;
  delete connections[name];
  writeConnections(dataDir, connections);
  return true;
}

/**
 * 重命名 connections.json 里的连接（原子写入：新键 + 删旧键）。
 * 返回是否确有重命名：旧连接不在数据目录（只存在于配置文件）时返回 false。
 */
export function renameConnection(dataDir: string, oldName: string, newName: string): boolean {
  assertValidConnectionName(newName);
  if (oldName === newName) return false;
  const connections = readConnections(dataDir);
  if (!Object.prototype.hasOwnProperty.call(connections, oldName)) return false;
  if (Object.prototype.hasOwnProperty.call(connections, newName)) {
    throw new ConnectionStoreError(`连接 "${newName}" 已存在，无法重命名`);
  }
  connections[newName] = connections[oldName]!;
  delete connections[oldName];
  writeConnections(dataDir, connections);
  return true;
}
