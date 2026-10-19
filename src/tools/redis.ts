import { z } from "zod";
import { executeRedisCommand, redisScan } from "../connections/redis.js";
import { checkRedisCommand, effectiveRowLimit } from "../readonly.js";
import type { ToolDefinition } from "./types.js";

const argSchema = z.union([z.string(), z.number(), z.boolean()]);

export const redisExecTool: ToolDefinition = {
  name: "redis_exec",
  title: "Redis 只读命令",
  description:
    "在指定 Redis 连接上执行只读命令（如 GET / MGET / HGETALL / LRANGE / SMEMBERS / ZRANGE / TYPE / TTL / DBSIZE / INFO / MEMORY USAGE 等）。" +
    "写命令与阻塞命令（SET / DEL / FLUSHALL / KEYS / EVAL / SUBSCRIBE 等）都会被拒绝。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    command: z.string().describe("Redis 命令名，例如 GET / HGETALL / LRANGE"),
    args: z.array(argSchema).optional().describe("命令参数，例如 [\"mykey\"] 或 [\"mylist\", \"0\", \"-1\"]"),
    limit: z.number().int().positive().optional().describe("数组结果返回条数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const command = args.command;
    const limit = effectiveRowLimit(
      typeof args.limit === "number" ? args.limit : undefined,
      ctx.config.limits.maxRows,
    );

    const checked = checkRedisCommand(command, args.args);
    if (!checked.ok) throw new Error(`拒绝执行: ${checked.reason}`);

    const client = ctx.connections.redisClient(connection);
    const result = await executeRedisCommand(client, checked.command!, checked.args!, { maxRows: limit });

    const header =
      `连接: ${connection}\n` +
      `命令: ${checked.command}${checked.args!.length > 0 ? ` ${checked.args!.join(" ")}` : ""}\n` +
      `结果条数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.value, null, 2)}`,
      structured: { value: result.value, rowCount: result.rowCount, truncated: result.truncated },
      connection,
      rowCount: result.rowCount,
      summary: `redis_exec ${checked.command} on ${connection}`,
    };
  },
};

export const redisScanTool: ToolDefinition = {
  name: "redis_scan",
  title: "Redis key 扫描",
  description:
    "基于 SCAN 增量扫描 key（不会像 KEYS 那样阻塞服务器）。返回本批次 key 与下次调用应使用的 cursor；cursor 为 \"0\" 表示扫描结束。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    pattern: z.string().optional().describe("MATCH 模式，例如 user:*"),
    cursor: z.string().optional().describe("上一次返回的 cursor，缺省为 \"0\""),
    count: z.number().int().positive().optional().describe("COUNT 提示（每次扫描的批次大小）"),
    type: z.string().optional().describe("按类型过滤（需 Redis 6+），例如 string / hash / list / set / zset / stream"),
    limit: z.number().int().positive().optional().describe("本批次返回 key 数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const limit = effectiveRowLimit(
      typeof args.limit === "number" ? args.limit : undefined,
      ctx.config.limits.maxRows,
    );

    const client = ctx.connections.redisClient(connection);
    const result = await redisScan(client, {
      pattern: typeof args.pattern === "string" ? args.pattern : undefined,
      cursor: typeof args.cursor === "string" ? args.cursor : undefined,
      count: typeof args.count === "number" ? args.count : undefined,
      type: typeof args.type === "string" ? args.type : undefined,
      maxRows: limit,
    });

    const header =
      `连接: ${connection}\n` +
      `cursor: ${result.cursor}\n` +
      `本批 key 数: ${result.keys.length}${result.truncated ? "（已截断）" : ""}` +
      (result.cursor === "0" ? "\n（cursor=0，扫描已结束）" : `\n（继续扫描请传 cursor=${result.cursor}）`);

    return {
      text: `${header}\n\n${JSON.stringify(result.keys, null, 2)}`,
      structured: { cursor: result.cursor, keys: result.keys, count: result.keys.length, truncated: result.truncated },
      connection,
      rowCount: result.keys.length,
      summary: `redis_scan on ${connection} (${result.keys.length} keys)`,
    };
  },
};
