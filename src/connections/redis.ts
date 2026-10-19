import { Redis } from "ioredis";
import type { RedisConnectionConfig } from "../config.js";
import { toJsonSafe } from "../json.js";

export interface RedisResult {
  value: unknown;
  rowCount: number;
  truncated: boolean;
}

export interface RedisScanResult {
  cursor: string;
  keys: string[];
  truncated: boolean;
}

interface RedisState {
  label: string;
  lastError?: Error;
}

/** 记录每个客户端的连接标识与最近一次错误，用于生成清晰的失败信息。 */
const states = new WeakMap<Redis, RedisState>();

/** 创建 Redis 客户端（懒连接；命令超时；失败后不重连，避免无谓重试与噪音）。 */
export function createRedisClient(config: RedisConnectionConfig, timeoutMs: number): Redis {
  const port = config.port ?? 6379;
  const client = new Redis({
    host: config.host,
    port,
    username: config.username,
    password: config.password,
    db: config.db,
    tls: config.tls ? {} : undefined,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
    commandTimeout: timeoutMs,
    retryStrategy: () => null,
  });

  states.set(client, {
    label: `${config.host}:${port}${config.db !== undefined ? `/${config.db}` : ""}`,
  });
  // ioredis 要求必须有 error 监听，否则会打印 "Unhandled error event"；这里捕获后统一在命令层抛出。
  client.on("error", (error: Error) => {
    const state = states.get(client);
    if (state) state.lastError = error;
  });

  return client;
}

function describeUnavailable(client: Redis, fallback: string): string {
  const state = states.get(client);
  const detail = state?.lastError?.message ?? fallback;
  return `无法连接 Redis (${state?.label ?? "unknown"}): ${detail}`;
}

async function ensureConnected(client: Redis): Promise<void> {
  const status = client.status;
  if (status === "wait") {
    try {
      await client.connect();
      return;
    } catch (error) {
      const state = states.get(client);
      // connect() 的拒绝有时早于 socket 的 error 事件，稍等一拍以拿到更具体的失败原因
      if (!state?.lastError) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const detail = state?.lastError?.message ?? (error instanceof Error ? error.message : String(error));
      if (state && !state.lastError && error instanceof Error) state.lastError = error;
      throw new Error(`无法连接 Redis (${state?.label ?? "unknown"}): ${detail}`);
    }
  }
  if (status === "end" || status === "close") {
    throw new Error(describeUnavailable(client, `连接状态为 ${status}`));
  }
}

/** 执行已通过白名单校验的只读命令。 */
export async function executeRedisCommand(
  client: Redis,
  command: string,
  args: string[],
  opts: { maxRows: number },
): Promise<RedisResult> {
  await ensureConnected(client);
  let reply: unknown;
  try {
    reply = await client.call(command, ...args);
  } catch (error) {
    if (client.status === "end" || client.status === "close") {
      throw new Error(describeUnavailable(client, `连接状态为 ${client.status}`));
    }
    throw error;
  }
  const safe = toJsonSafe(reply);
  if (Array.isArray(safe)) {
    const truncated = safe.length > opts.maxRows;
    const value = truncated ? safe.slice(0, opts.maxRows) : safe;
    return { value, rowCount: value.length, truncated };
  }
  return { value: safe, rowCount: safe === null ? 0 : 1, truncated: false };
}

export interface RedisScanOptions {
  pattern?: string;
  cursor?: string;
  count?: number;
  type?: string;
  maxRows: number;
}
/** 基于 SCAN 的健集扫描（替代 KEYS）。 */
export async function redisScan(client: Redis, opts: RedisScanOptions): Promise<RedisScanResult> {
  await ensureConnected(client);
  const args: Array<string | number> = [opts.cursor ?? "0"];
  if (opts.pattern) args.push("MATCH", opts.pattern);
  if (opts.count !== undefined) args.push("COUNT", opts.count);
  if (opts.type) args.push("TYPE", opts.type);

  const reply = (await client.call("SCAN", ...args)) as [string, string[]];
  const cursor = String(reply?.[0] ?? "0");
  const allKeys = Array.isArray(reply?.[1]) ? reply[1].map((key) => String(key)) : [];
  const truncated = allKeys.length > opts.maxRows;
  return {
    cursor,
    keys: truncated ? allKeys.slice(0, opts.maxRows) : allKeys,
    truncated,
  };
}

/** PING：仅供「测试连通性」使用（PING 不在只读白名单里，不对外暴露为工具）。 */
export async function redisPing(client: Redis): Promise<string> {
  await ensureConnected(client);
  try {
    return String(await client.ping());
  } catch (error) {
    if (client.status === "end" || client.status === "close") {
      throw new Error(describeUnavailable(client, `连接状态为 ${client.status}`));
    }
    throw error;
  }
}
