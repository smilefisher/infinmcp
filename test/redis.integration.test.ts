import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { ConnectionManager } from "../src/connections/manager.js";
import { createRedisClient, executeRedisCommand, redisScan } from "../src/connections/redis.js";
import { checkRedisCommand } from "../src/readonly.js";
import type { RedisConnectionConfig } from "../src/config.js";

/**
 * 真实 Redis 集成测试：仅在设置 INFINMCP_TEST_REDIS 时运行。
 * 例：INFINMCP_TEST_REDIS='redis://127.0.0.1:6379/0' npm test
 */
const uri = process.env.INFINMCP_TEST_REDIS;

function parseRedisUri(value: string): RedisConnectionConfig {
  const parsed = new URL(value);
  return {
    type: "redis",
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: parsed.pathname.replace(/^\//, "") ? Number(parsed.pathname.replace(/^\//, "")) : undefined,
  };
}

describe.skipIf(!uri)("Redis 集成（需要 INFINMCP_TEST_REDIS）", () => {
  let client: Redis;

  beforeAll(() => {
    client = createRedisClient(parseRedisUri(uri!), 5000);
  });

  afterAll(async () => {
    await client.quit().catch(() => client.disconnect());
  });

  it("INFO 可用", async () => {
    const checked = checkRedisCommand("INFO", []);
    expect(checked.ok).toBe(true);
    const result = await executeRedisCommand(client, checked.command!, checked.args!, { maxRows: 100 });
    expect(String(result.value)).toContain("redis_version");
  });

  it("DBSIZE 返回数字", async () => {
    const checked = checkRedisCommand("DBSIZE", []);
    const result = await executeRedisCommand(client, checked.command!, checked.args!, { maxRows: 100 });
    expect(typeof result.value).toBe("number");
  });

  it("SCAN 返回 cursor 与 keys", async () => {
    const result = await redisScan(client, { cursor: "0", count: 10, maxRows: 100 });
    expect(typeof result.cursor).toBe("string");
    expect(Array.isArray(result.keys)).toBe(true);
  });

  it("写命令被守卫拒绝", () => {
    expect(checkRedisCommand("SET", ["k", "v"]).ok).toBe(false);
    expect(checkRedisCommand("FLUSHALL", []).ok).toBe(false);
    expect(checkRedisCommand("KEYS", ["*"]).ok).toBe(false);
  });

  it("ConnectionManager 端到端", async () => {
    const config: RedisConnectionConfig = parseRedisUri(uri!);
    const manager = new ConnectionManager({ connections: { r: config }, timeoutMs: 5000 });
    const checked = checkRedisCommand("PING", []);
    // PING 不在白名单（非数据读取），改为 DBSIZE
    expect(checked.ok).toBe(false);
    const dbsize = checkRedisCommand("DBSIZE", []);
    const result = await executeRedisCommand(manager.redisClient("r"), dbsize.command!, dbsize.args!, {
      maxRows: 100,
    });
    expect(typeof result.value).toBe("number");
    await manager.closeAll();
  });
});
