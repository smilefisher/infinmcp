import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/** 配置相关的可读错误，CLI 捕获后直接展示 message。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const CONNECTIONS_FILE = "connections.json";
const DEFAULT_LOG_FILE = "~/.infinmcp/logs.jsonl";

// ---------------------------------------------------------------------------
// 路径与环境变量
// ---------------------------------------------------------------------------

/** 展开 `~` 并把相对路径按 baseDir 解析为绝对路径。 */
export function expandPath(input: string, baseDir: string): string {
  let out = input;
  if (out === "~") out = homedir();
  else if (out.startsWith("~/")) out = join(homedir(), out.slice(2));
  return isAbsolute(out) ? out : resolve(baseDir, out);
}

const ENV_RE = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** 递归把 `{env:VAR}` 字符串替换为环境变量值；缺失的变量名记入 missing。 */
export function substituteEnv<T>(value: T, missing: Set<string>, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === "string") {
    const match = ENV_RE.exec(value);
    if (match) {
      const key = match[1]!;
      const val = env[key];
      if (val === undefined) {
        missing.add(key);
        return "" as unknown as T;
      }
      return val as unknown as T;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteEnv(item, missing, env)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = substituteEnv(item, missing, env);
    }
    return out as unknown as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const PortSchema = z.number().int().min(1).max(65535);

const MysqlConnectionSchema = z.object({
  type: z.literal("mysql"),
  host: z.string().min(1),
  port: PortSchema.optional(),
  user: z.string().min(1),
  password: z.string().optional(),
  database: z.string().optional(),
  charset: z.string().optional(),
});

const DorisConnectionSchema = z.object({
  type: z.literal("doris"),
  host: z.string().min(1),
  port: PortSchema.optional(),
  user: z.string().min(1),
  password: z.string().optional(),
  database: z.string().optional(),
  charset: z.string().optional(),
});

const RedisConnectionSchema = z.object({
  type: z.literal("redis"),
  host: z.string().min(1),
  port: PortSchema.optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  db: z.number().int().min(0).optional(),
  tls: z.boolean().optional(),
});

const MongoConnectionSchema = z.object({
  type: z.literal("mongodb"),
  uri: z.string().min(1),
  database: z.string().optional(),
});

export const ConnectionSchema = z.discriminatedUnion("type", [
  MysqlConnectionSchema,
  DorisConnectionSchema,
  RedisConnectionSchema,
  MongoConnectionSchema,
]);

export const ApiKeySchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1),
  role: z.enum(["admin", "user"]).default("user"),
});

export const ServerSchema = z.object({
  host: z.string().min(1).default("0.0.0.0"),
  port: PortSchema.default(8787),
  apiKeys: z.array(ApiKeySchema).default([]),
});

export const LimitsSchema = z.object({
  maxRows: z.number().int().min(1).default(200),
  timeoutMs: z.number().int().min(1).default(10000),
});

export const LogsSchema = z.object({
  file: z.string().min(1).default(DEFAULT_LOG_FILE),
});

const RawConfigSchema = z.object({
  server: ServerSchema.optional(),
  connections: z.record(z.string().min(1), ConnectionSchema).default({}),
  limits: LimitsSchema.default({ maxRows: 200, timeoutMs: 10000 }),
  logs: LogsSchema.default({ file: DEFAULT_LOG_FILE }),
});

const ConnectionsFileSchema = z.object({
  connections: z.record(z.string().min(1), ConnectionSchema).default({}),
});

export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type ApiKey = z.infer<typeof ApiKeySchema>;
export type MysqlConnectionConfig = Extract<ConnectionConfig, { type: "mysql" }>;
export type DorisConnectionConfig = Extract<ConnectionConfig, { type: "doris" }>;
export type RedisConnectionConfig = Extract<ConnectionConfig, { type: "redis" }>;
export type MongoConnectionConfig = Extract<ConnectionConfig, { type: "mongodb" }>;

// ---------------------------------------------------------------------------
// 加载结果
// ---------------------------------------------------------------------------

export interface LoadedConfig {
  /** 命中的配置文件绝对路径；未找到为 null。 */
  configPath: string | null;
  /** 数据目录（存放 connections.json 等可写文件）。 */
  dataDir: string;
  server: z.infer<typeof ServerSchema>;
  connections: Record<string, ConnectionConfig>;
  limits: z.infer<typeof LimitsSchema>;
  logs: z.infer<typeof LogsSchema>;
  /** 加载过程中的非致命提示。 */
  warnings: string[];
}

export interface LoadOptions {
  configPath?: string;
  dataDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

function readJsonObject(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new ConfigError(`无法读取配置文件 ${file}: ${(error as Error).message}`);
  }
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ConfigError(`配置文件 ${file} 不是合法 JSON: ${(error as Error).message}`);
  }
}

function findConfigFile(explicit: string | undefined, cwd: string, env: NodeJS.ProcessEnv): string | null {
  const fromExplicit = explicit ?? env.INFINMCP_CONFIG;
  if (fromExplicit) {
    const resolved = expandPath(fromExplicit, cwd);
    if (!existsSync(resolved)) {
      throw new ConfigError(`指定的配置文件不存在: ${resolved}`);
    }
    return resolved;
  }
  const candidates = [
    join(cwd, "infinmcp.config.json"),
    join(homedir(), ".config", "infinmcp", "config.json"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("\n");
}

/**
 * 加载并校验配置：静态配置文件 + 可写 connections.json（后者覆盖前者）。
 * 缺失的 `{env:...}` 变量会直接报错，避免静默地以空口令连接。
 */
export function loadConfig(options: LoadOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const warnings: string[] = [];

  const configPath = findConfigFile(options.configPath, cwd, env);
  const rawSource = configPath ? readJsonObject(configPath) : {};

  const missing = new Set<string>();
  const substituted = substituteEnv(rawSource, missing, env);
  if (missing.size > 0) {
    throw new ConfigError(
      `以下环境变量未设置，无法解析配置中的 {env:...} 占位符: ${[...missing].sort().join(", ")}`,
    );
  }

  const parsed = RawConfigSchema.safeParse(substituted);
  if (!parsed.success) {
    throw new ConfigError(`配置校验失败:\n${formatZodError(parsed.error)}`);
  }

  const dataDir = expandPath(
    options.dataDir ?? env.INFINMCP_DATA_DIR ?? join(homedir(), ".config", "infinmcp"),
    cwd,
  );

  const connections: Record<string, ConnectionConfig> = { ...parsed.data.connections };
  const connectionsFile = join(dataDir, CONNECTIONS_FILE);
  if (existsSync(connectionsFile)) {
    const fileMissing = new Set<string>();
    const fileRaw = substituteEnv(readJsonObject(connectionsFile), fileMissing, env);
    if (fileMissing.size > 0) {
      throw new ConfigError(
        `${connectionsFile} 中以下环境变量未设置: ${[...fileMissing].sort().join(", ")}`,
      );
    }
    const fileParsed = ConnectionsFileSchema.safeParse(fileRaw);
    if (!fileParsed.success) {
      warnings.push(`${connectionsFile} 校验失败，已忽略:\n${formatZodError(fileParsed.error)}`);
    } else {
      for (const [name, config] of Object.entries(fileParsed.data.connections)) {
        if (name in connections) {
          warnings.push(`连接 "${name}" 同时存在于配置文件和 ${connectionsFile}，以数据目录中的为准`);
        }
        connections[name] = config;
      }
    }
  }

  const server = parsed.data.server ?? ServerSchema.parse({});
  const keyNames = new Set<string>();
  for (const apiKey of server.apiKeys) {
    if (keyNames.has(apiKey.name)) {
      warnings.push(`API Key 名称重复: "${apiKey.name}"`);
    }
    keyNames.add(apiKey.name);
  }

  const logs = { file: expandPath(parsed.data.logs.file, configPath ? dirname(configPath) : cwd) };

  return {
    configPath,
    dataDir,
    server,
    connections,
    limits: parsed.data.limits,
    logs,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// 脱敏摘要（供 CLI 打印；绝不包含 Key / 密码明文）
// ---------------------------------------------------------------------------

export function redactMongoUri(uri: string): string {
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) {
      parsed.username = "***";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return "***";
  }
}

/** 连接的脱敏结构信息，可安全地回给模型 / 前端。 */
export interface SafeConnectionInfo {
  name: string;
  type: "mysql" | "doris" | "redis" | "mongodb";
  host?: string;
  port?: number;
  database?: string;
  db?: number;
  user?: string;
  uri?: string;
  hasPassword: boolean;
}

export function safeConnectionInfo(name: string, config: ConnectionConfig): SafeConnectionInfo {
  if (config.type === "mysql" || config.type === "doris") {
    return {
      name,
      type: config.type,
      host: config.host,
      port: config.port ?? (config.type === "mysql" ? 3306 : 9030),
      database: config.database,
      user: config.user,
      hasPassword: Boolean(config.password),
    };
  }
  if (config.type === "redis") {
    return {
      name,
      type: "redis",
      host: config.host,
      port: config.port ?? 6379,
      db: config.db,
      user: config.username,
      hasPassword: Boolean(config.password),
    };
  }
  let hasPassword = false;
  try {
    hasPassword = Boolean(new URL(config.uri).password);
  } catch {
    hasPassword = false;
  }
  return {
    name,
    type: "mongodb",
    database: config.database,
    uri: redactMongoUri(config.uri),
    hasPassword,
  };
}

/** 返回单个连接的脱敏描述（不含密码）。 */
export function describeConnection(name: string, config: ConnectionConfig): string {
  const info = safeConnectionInfo(name, config);
  const secret = info.hasPassword ? ", password=***" : "";
  if (info.type === "mysql" || info.type === "doris") {
    const db = info.database ? `/${info.database}` : "";
    return `${name} [${info.type}] ${info.user}@${info.host}:${info.port}${db}${secret}`;
  }
  if (info.type === "redis") {
    const db = info.db !== undefined ? ` db=${info.db}` : "";
    return `${name} [redis] ${info.host}:${info.port}${db}${secret}`;
  }
  const db = info.database ? ` db=${info.database}` : "";
  return `${name} [mongodb] ${info.uri}${db}${secret}`;
}

/** 生成整份配置的脱敏多行摘要。 */
export function summarizeConfig(config: LoadedConfig): string[] {
  const lines: string[] = [];
  lines.push(`配置文件: ${config.configPath ?? "(未找到，使用默认值)"}`);
  lines.push(`数据目录: ${config.dataDir}`);
  lines.push(`日志文件: ${config.logs.file}`);
  lines.push(`服务监听: ${config.server.host}:${config.server.port}`);

  const keys = config.server.apiKeys.map((k) => `${k.name}(${k.role})`);
  lines.push(`API Keys: ${keys.length > 0 ? keys.join(", ") : "(未配置)"}`);

  const names = Object.keys(config.connections);
  if (names.length === 0) {
    lines.push("连接: (无)");
  } else {
    lines.push(`连接 (${names.length}):`);
    for (const name of names) {
      lines.push(`  - ${describeConnection(name, config.connections[name]!)}`);
    }
  }

  lines.push(`限制: maxRows=${config.limits.maxRows}, timeoutMs=${config.limits.timeoutMs}`);
  return lines;
}
