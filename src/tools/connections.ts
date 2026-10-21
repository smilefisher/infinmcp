import { z } from "zod";
import { describeConnection, safeConnectionInfo, type ConnectionConfig } from "../config.js";
import { assertValidConnectionName } from "../connectionsStore.js";
import { testConnection } from "../connections/test.js";
import type { ConnectionManageCapability, ToolDefinition, ToolContext } from "./types.js";

/**
 * 四种连接类型共用的扁平参数表。
 * MySQL / Doris 同构；MongoDB 用 `uri`；Redis 用 `username`（这里统一暴露为 `user`）。
 */
const connectionArgs = {
  name: z.string().describe("连接名：支持中文 / 字母 / 数字 / 空格 / 下划线 / 点 / 连字符，最长 64"),
  type: z
    .enum(["mysql", "doris", "redis", "mongodb"])
    .optional()
    .describe("数据库类型；create 必填，update 省略表示沿用现有类型"),
  host: z.string().optional().describe("主机名或 IP（mysql / doris / redis 必填）"),
  port: z.number().int().min(1).max(65535).optional().describe("端口；缺省 mysql=3306 / doris=9030 / redis=6379"),
  user: z.string().optional().describe("用户名（mysql / doris 必填；redis 为 ACL 用户名，可空）"),
  password: z.string().optional().describe("口令；update 时省略表示沿用旧值"),
  database: z.string().optional().describe("默认库（mysql / doris / mongodb）"),
  charset: z.string().optional().describe("字符集（mysql / doris，建议 utf8mb4）"),
  db: z.number().int().min(0).optional().describe("Redis 逻辑库编号，默认 0"),
  tls: z.boolean().optional().describe("Redis 是否使用 TLS"),
  uri: z.string().optional().describe("MongoDB 连接串（mongodb 必填，含账号口令与 authSource）"),
  env: z
    .enum(["prod", "test", "dev"])
    .nullable()
    .optional()
    .describe("环境标签（prod / test / dev；传 null 清除）。仅元数据，服务端不据此路由"),
  readonly: z
    .boolean()
    .nullable()
    .optional()
    .describe("数据库账号是否只读（true=只读；false=可能有写权限；传 null 清除）"),
  maxRows: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe("该连接的行数上限（只能调低全局 limits.maxRows；传 null 清除）"),
};

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 校验并返回连接名（不合法时抛 ConnectionStoreError）。 */
function requireName(args: Record<string, unknown>): string {
  const name = str(args, "name")?.trim();
  if (!name) throw new Error("缺少参数 name（连接名）");
  assertValidConnectionName(name);
  return name;
}

/** 把扁平参数整理成 ConnectionSchema 能接受的配置对象；空串视为「未提供」。 */
function toRawConfig(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const type = str(args, "type");
  if (type) out.type = type;

  for (const key of ["host", "database", "charset", "uri"] as const) {
    const value = str(args, key);
    if (value) out[key] = value;
  }
  // 口令允许为空串以外的任何值；空串表示沿用旧值（与 Web 表单一致）
  if (typeof args.password === "string" && args.password !== "") out.password = args.password;

  const user = str(args, "user");
  if (user) out.user = user; // 具体落到 user 还是 username，由 normalizeUserKey 按类型决定

  if (typeof args.port === "number") out.port = args.port;
  if (typeof args.db === "number") out.db = args.db;
  if (typeof args.tls === "boolean") out.tls = args.tls;

  // 元数据：null 表示「清除该标签」（配合 update 的合并语义）
  if (args.env === null) out.env = undefined;
  else if (typeof args.env === "string" && args.env !== "") out.env = args.env;

  if (args.readonly === null) out.readonly = undefined;
  else if (typeof args.readonly === "boolean") out.readonly = args.readonly;

  if (args.maxRows === null) out.maxRows = undefined;
  else if (typeof args.maxRows === "number") out.maxRows = args.maxRows;

  return out;
}

/** 把 user 统一成目标类型期望的键名：Redis 用 username，其余用 user。 */
function normalizeUserKey(raw: Record<string, unknown>, type: unknown): Record<string, unknown> {
  const out = { ...raw };
  const user = out.user ?? out.username;
  delete out.user;
  delete out.username;
  if (typeof user === "string" && user !== "") {
    if (type === "redis") out.username = user;
    else out.user = user;
  }
  return out;
}

/**
 * 把「现有配置」与「本次传入」合并，实现**真·部分更新**：未提供的字段保持原值。
 * 仅当类型发生变更时丢弃旧类型字段（避免把 redis 的 db 带到 mysql）。
 */
function mergeForUpdate(existing: ConnectionConfig, incoming: Record<string, unknown>): Record<string, unknown> {
  const changedType = typeof incoming.type === "string" && incoming.type !== existing.type;
  const merged: Record<string, unknown> = changedType ? { ...incoming } : { ...existing, ...incoming };
  merged.type = changedType ? incoming.type : existing.type;
  return normalizeUserKey(merged, merged.type);
}

/** 取连接管理能力；stdio 模式或后台开关关闭时抛出可读错误。 */
function requireManage(ctx: ToolContext): ConnectionManageCapability {
  const manage = ctx.manage;
  if (!manage) {
    throw new Error(
      "连接管理仅在 HTTP serve 模式下可用；stdio 模式为只读，请在 Web 控制台或配置文件里管理连接",
    );
  }
  if (!manage.enabled) {
    throw new Error(
      "管理员未开启「允许 AI 管理连接」。请让管理员在 Web 控制台 → 连接 页勾选后再试",
    );
  }
  return manage;
}

function savedResult(action: string, name: string, config: ConnectionConfig, globalMaxRows?: number) {
  return {
    text: `已${action}连接：\n- ${describeConnection(name, config)}`,
    structured: { connection: safeConnectionInfo(name, config, globalMaxRows) },
    connection: name,
    summary: `${action} connection ${name} (${config.type})`,
  };
}

/** 新增连接（名称冲突时报错，提示改用 update_connection）。 */
export const createConnectionTool: ToolDefinition = {
  name: "create_connection",
  title: "新增数据库连接",
  description:
    "新增一个数据库连接并立即生效（写入服务端数据目录的 connections.json），支持 mysql / doris / redis / mongodb。" +
    "可选元数据 env（prod/test/dev）、readonly（数据库账号是否只读）、maxRows（该连接行数上限）只做展示与限制，不做环境路由。" +
    "需要管理员在 Web 控制台「连接」页勾选「允许 AI 管理连接」，否则会被拒绝；名称已存在时请改用 update_connection。",
  inputSchema: connectionArgs,
  async handler(args, ctx) {
    const manage = requireManage(ctx);
    const name = requireName(args);
    const type = str(args, "type");
    if (!type) throw new Error("缺少参数 type（mysql / doris / redis / mongodb）");
    if (ctx.connections.has(name)) {
      throw new Error(`连接 "${name}" 已存在；如需修改请用 update_connection`);
    }
    const config = await manage.upsert(name, normalizeUserKey(toRawConfig(args), type));
    return savedResult("新增", name, config, ctx.config.limits.maxRows);
  },
};

/** 更新已存在的连接（部分更新：只改传入的字段，未传的保持原值）。 */
export const updateConnectionTool: ToolDefinition = {
  name: "update_connection",
  title: "更新数据库连接",
  description:
    "更新一个已存在的连接并立即生效，**部分更新**：只传要改的字段，未传的字段保持原值（含 database / charset / tls / db / port）。" +
    "省略 password（MySQL / Doris / Redis）或 uri（MongoDB）也沿用旧值；省略 type 沿用现有类型。" +
    "env / readonly / maxRows 传 null 可清除该标签。需要管理员开启「允许 AI 管理连接」。",
  inputSchema: connectionArgs,
  async handler(args, ctx) {
    const manage = requireManage(ctx);
    const name = requireName(args);
    if (!ctx.connections.has(name)) {
      throw new Error(`连接 "${name}" 不存在；如需新增请用 create_connection`);
    }
    const existing = ctx.connections.getConfig(name);
    const config = await manage.upsert(name, mergeForUpdate(existing, toRawConfig(args)));
    return savedResult("更新", name, config, ctx.config.limits.maxRows);
  },
};

/** 删除连接（仅限落在 connections.json 里的连接）。 */
export const deleteConnectionTool: ToolDefinition = {
  name: "delete_connection",
  title: "删除数据库连接",
  description:
    "删除一个连接并立即生效。只能删除数据目录 connections.json 里的连接；若连接来自服务端配置文件，" +
    "请改配置文件后重启。需要管理员开启「允许 AI 管理连接」。此操作不可逆。",
  inputSchema: { name: z.string().describe("要删除的连接名") },
  async handler(args, ctx) {
    const manage = requireManage(ctx);
    const name = requireName(args);
    if (!ctx.connections.has(name)) throw new Error(`连接 "${name}" 不存在`);
    const removed = await manage.remove(name);
    if (!removed) {
      throw new Error(`连接 "${name}" 只存在于配置文件，无法通过工具删除；请修改配置文件后重启服务`);
    }
    return {
      text: `已删除连接：${name}`,
      structured: { deleted: name },
      connection: name,
      summary: `delete_connection ${name}`,
    };
  },
};

/** 测试已有连接的连通性；只读探测，不落盘，不需要开关。 */
export const testConnectionTool: ToolDefinition = {
  name: "test_connection",
  title: "测试连接连通性",
  description:
    "测试一个已存在连接的连通性（MySQL / Doris `SELECT 1`、Redis `PING`、MongoDB `ping`）。" +
    "只读探测、不修改配置；连不上时返回 ok:false 与原因，而不是报错。",
  inputSchema: { name: z.string().describe("要测试的连接名，见 list_connections") },
  async handler(args, ctx) {
    const name = requireName(args);
    if (!ctx.connections.has(name)) throw new Error(`连接 "${name}" 不存在，可用连接见 list_connections`);
    const result = await testConnection(ctx.connections, name);
    const detail = result.ok ? (result.detail ?? "成功") : (result.error ?? "失败");
    return {
      text: `${result.ok ? "✅ 可用" : "❌ 不可用"}：${name} [${result.type}] ${detail}（${result.latencyMs}ms）`,
      structured: { ...result },
      connection: name,
      summary: `test_connection ${name} (${result.ok ? "ok" : "failed"})`,
    };
  },
};
