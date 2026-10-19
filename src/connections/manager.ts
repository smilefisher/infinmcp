import type { Pool } from "mysql2/promise";
import type { Redis } from "ioredis";
import type { MongoClient } from "mongodb";
import type {
  ConnectionConfig,
  DorisConnectionConfig,
  MongoConnectionConfig,
  MysqlConnectionConfig,
  RedisConnectionConfig,
} from "../config.js";
import { createMysqlPool } from "./mysql.js";
import { createDorisPool } from "./doris.js";
import { createRedisClient } from "./redis.js";
import { createMongoClient } from "./mongodb.js";

type Handle =
  | { type: "mysql"; pool: Pool }
  | { type: "doris"; pool: Pool }
  | { type: "redis"; client: Redis }
  | { type: "mongodb"; client: MongoClient };

export interface ConnectionManagerOptions {
  connections: Record<string, ConnectionConfig>;
  /** 连接/语句超时（毫秒）。 */
  timeoutMs: number;
}

/**
 * 按连接名懒加载并复用驱动句柄。
 * 已实现 MySQL / Doris（第 3 步）、Redis（第 4 步）与 MongoDB（第 5 步）。
 */
export class ConnectionManager {
  private readonly configs: Record<string, ConnectionConfig>;
  private readonly timeoutMs: number;
  private readonly handles = new Map<string, Handle>();

  constructor(options: ConnectionManagerOptions) {
    this.configs = options.connections;
    this.timeoutMs = options.timeoutMs;
  }

  /** 全部连接名。 */
  names(): string[] {
    return Object.keys(this.configs);
  }

  has(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.configs, name);
  }

  /** 取连接配置；不存在时抛出可读错误。 */
  getConfig(name: string): ConnectionConfig {
    const config = this.configs[name];
    if (!config) {
      const known = this.names();
      const hint = known.length > 0 ? `可用连接: ${known.join(", ")}` : "当前没有任何连接";
      throw new Error(`未知连接 "${name}"。${hint}`);
    }
    return config;
  }

  /** 取（或创建）MySQL 连接池。 */
  mysqlPool(name: string): Pool {
    const config = this.getConfig(name);
    if (config.type !== "mysql") {
      throw new Error(`连接 "${name}" 的类型是 ${config.type}，不能作为 MySQL 使用`);
    }
    const existing = this.handles.get(name);
    if (existing && existing.type === "mysql") return existing.pool;

    const pool = createMysqlPool(config as MysqlConnectionConfig, this.timeoutMs);
    this.handles.set(name, { type: "mysql", pool });
    return pool;
  }

  /** 取（或创建）Doris 连接池。 */
  dorisPool(name: string): Pool {
    const config = this.getConfig(name);
    if (config.type !== "doris") {
      throw new Error(`连接 "${name}" 的类型是 ${config.type}，不能作为 Doris 使用`);
    }
    const existing = this.handles.get(name);
    if (existing && existing.type === "doris") return existing.pool;

    const pool = createDorisPool(config as DorisConnectionConfig, this.timeoutMs);
    this.handles.set(name, { type: "doris", pool });
    return pool;
  }

  /** 取（或创建）Redis 客户端。 */
  redisClient(name: string): Redis {
    const config = this.getConfig(name);
    if (config.type !== "redis") {
      throw new Error(`连接 "${name}" 的类型是 ${config.type}，不能作为 Redis 使用`);
    }
    const existing = this.handles.get(name);
    if (existing && existing.type === "redis") return existing.client;

    const client = createRedisClient(config as RedisConnectionConfig, this.timeoutMs);
    this.handles.set(name, { type: "redis", client });
    return client;
  }

  /** 取（或创建）MongoDB 客户端。 */
  mongoClient(name: string): MongoClient {
    const config = this.getConfig(name);
    if (config.type !== "mongodb") {
      throw new Error(`连接 "${name}" 的类型是 ${config.type}，不能作为 MongoDB 使用`);
    }
    const existing = this.handles.get(name);
    if (existing && existing.type === "mongodb") return existing.client;

    const client = createMongoClient(config as MongoConnectionConfig, this.timeoutMs);
    this.handles.set(name, { type: "mongodb", client });
    return client;
  }

  /** 关闭并移除某个连接的句柄（供 Web 改配置后热生效）。 */
  async invalidate(name: string): Promise<void> {
    const handle = this.handles.get(name);
    if (!handle) return;
    this.handles.delete(name);
    if (handle.type === "mysql" || handle.type === "doris") {
      await handle.pool.end();
      return;
    }
    if (handle.type === "mongodb") {
      await handle.client.close();
      return;
    }
    try {
      if (handle.client.status === "wait") handle.client.disconnect();
      else await handle.client.quit();
    } catch {
      handle.client.disconnect();
    }
  }

  /** 关闭所有句柄。 */
  async closeAll(): Promise<void> {
    const names = [...this.handles.keys()];
    await Promise.all(names.map((name) => this.invalidate(name)));
  }
}
