import { mongoPing } from "./mongodb.js";
import { redisPing } from "./redis.js";
import type { ConnectionManager } from "./manager.js";

export interface ConnectionTestResult {
  ok: boolean;
  type: string;
  latencyMs: number;
  detail?: string;
  error?: string;
}

/**
 * 测试连接连通性：跑一条最小的只读指令（MySQL / Doris `SELECT 1` / Redis `PING` / MongoDB `ping`）。
 * 连不上不抛错，而是返回 `ok: false` + 原因，方便前端直接展示。
 */
export async function testConnection(manager: ConnectionManager, name: string): Promise<ConnectionTestResult> {
  const config = manager.getConfig(name);
  const started = Date.now();
  // 夹住下界：极端情况下系统时钟回拨会让差值变负，展示成负数很怪。
  const elapsed = (): number => Math.max(0, Date.now() - started);

  try {
    if (config.type === "mysql") {
      await manager.mysqlPool(name).query("SELECT 1 AS ok");
      return { ok: true, type: "mysql", latencyMs: elapsed(), detail: "SELECT 1 成功" };
    }
    if (config.type === "doris") {
      await manager.dorisPool(name).query("SELECT 1 AS ok");
      return { ok: true, type: "doris", latencyMs: elapsed(), detail: "SELECT 1 成功" };
    }
    if (config.type === "redis") {
      const pong = await redisPing(manager.redisClient(name));
      return { ok: true, type: "redis", latencyMs: elapsed(), detail: `PING → ${pong}` };
    }
    const detail = await mongoPing(manager.mongoClient(name), config.database);
    return { ok: true, type: "mongodb", latencyMs: elapsed(), detail };
  } catch (error) {
    return {
      ok: false,
      type: config.type,
      latencyMs: elapsed(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
