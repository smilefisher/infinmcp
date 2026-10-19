import { describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import { mysqlQuery } from "../src/connections/mysql.js";
import { dorisQuery } from "../src/connections/doris.js";
import { executeRedisCommand } from "../src/connections/redis.js";
import { mongoListCollections } from "../src/connections/mongodb.js";
import type { ConnectionConfig } from "../src/config.js";

const connections: Record<string, ConnectionConfig> = {
  main: { type: "mysql", host: "127.0.0.1", user: "ro", database: "app" },
  warehouse: { type: "doris", host: "127.0.0.1", user: "ro", database: "app" },
  cache: { type: "redis", host: "127.0.0.1" },
  docs: { type: "mongodb", uri: "mongodb://localhost:27017" },
};

function manager(): ConnectionManager {
  return new ConnectionManager({ connections, timeoutMs: 1000 });
}

describe("ConnectionManager", () => {
  it("列出 / 判断连接", () => {
    const m = manager();
    expect(m.names().sort()).toEqual(["cache", "docs", "main", "warehouse"]);
    expect(m.has("main")).toBe(true);
    expect(m.has("nope")).toBe(false);
  });

  it("未知连接报错并提示可用连接", () => {
    const m = manager();
    expect(() => m.getConfig("nope")).toThrowError(/未知连接 "nope".*cache/);
  });

  it("类型不匹配时报错", () => {
    const m = manager();
    expect(() => m.mysqlPool("cache")).toThrowError(/类型是 redis/);
    expect(() => m.mysqlPool("warehouse")).toThrowError(/类型是 doris/);
    expect(() => m.dorisPool("main")).toThrowError(/类型是 mysql/);
    expect(() => m.dorisPool("cache")).toThrowError(/类型是 redis/);
    expect(() => m.redisClient("main")).toThrowError(/类型是 mysql/);
    expect(() => m.redisClient("docs")).toThrowError(/类型是 mongodb/);
    expect(() => m.mongoClient("main")).toThrowError(/类型是 mysql/);
    expect(() => m.mongoClient("cache")).toThrowError(/类型是 redis/);
  });

  it("mysqlPool 懒加载并可关闭", async () => {
    const m = manager();
    const pool = m.mysqlPool("main");
    expect(m.mysqlPool("main")).toBe(pool);
    await m.closeAll();
  });

  it("dorisPool 懒加载并可关闭", async () => {
    const m = manager();
    const pool = m.dorisPool("warehouse");
    expect(m.dorisPool("warehouse")).toBe(pool);
    await m.closeAll();
  });

  it("redisClient 懒加载并可关闭（未连接也不报错）", async () => {
    const m = manager();
    const client = m.redisClient("cache");
    expect(m.redisClient("cache")).toBe(client);
    expect(client.status).toBe("wait");
    await m.closeAll();
  });

  it("mongoClient 懒加载并可关闭（未连接也不报错）", async () => {
    const m = manager();
    const client = m.mongoClient("docs");
    expect(m.mongoClient("docs")).toBe(client);
    await m.closeAll();
  });

  it("MongoDB 连接失败时给出清晰错误（且 URI 口令已脱敏）", async () => {
    const m = new ConnectionManager({
      connections: {
        bad: { type: "mongodb", uri: "mongodb://user:secret@127.0.0.1:1/admin", database: "admin" },
      },
      timeoutMs: 800,
    });
    try {
      await expect(
        mongoListCollections(m.mongoClient("bad"), { database: "admin", maxRows: 10, timeoutMs: 800 }),
      ).rejects.toThrowError(/无法连接 MongoDB \(mongodb:\/\/\*\*\*@127\.0\.0\.1:1\/admin\)/);
    } finally {
      await m.closeAll();
    }
  }, 15000);

  it("Redis 连接失败时给出清晰错误且不产生未处理错误事件", async () => {
    const m = new ConnectionManager({
      connections: { bad: { type: "redis", host: "127.0.0.1", port: 1 } },
      timeoutMs: 1000,
    });
    const client = m.redisClient("bad");
    const unhandled: unknown[] = [];
    const onError = (error: unknown) => unhandled.push(error);
    process.on("uncaughtException", onError);
    try {
      await expect(executeRedisCommand(client, "DBSIZE", [], { maxRows: 10 })).rejects.toThrowError(
        /无法连接 Redis \(127\.0\.0\.1:1\)/,
      );
    } finally {
      process.off("uncaughtException", onError);
      await m.closeAll();
    }
    expect(unhandled).toHaveLength(0);
  }, 15000);

  it("MySQL 连接失败时给出清晰错误（含 host:port/database）", async () => {
    const m = new ConnectionManager({
      connections: {
        bad: { type: "mysql", host: "127.0.0.1", port: 1, user: "ro", password: "pw", database: "app" },
      },
      timeoutMs: 1000,
    });
    try {
      await expect(mysqlQuery(m.mysqlPool("bad"), "SELECT 1", [], { maxRows: 10, timeoutMs: 1000 })).rejects.toThrowError(
        /无法连接 MySQL \(127\.0\.0\.1:1\/app\): connect ECONNREFUSED/,
      );
    } finally {
      await m.closeAll();
    }
  }, 15000);

  it("MySQL 连接失败信息不含口令", async () => {
    const m = new ConnectionManager({
      connections: {
        bad: { type: "mysql", host: "127.0.0.1", port: 1, user: "ro", password: "top-secret-pw", database: "app" },
      },
      timeoutMs: 1000,
    });
    try {
      const error = await mysqlQuery(m.mysqlPool("bad"), "SELECT 1", [], { maxRows: 10, timeoutMs: 1000 })
        .then(() => null)
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
      expect(error).toContain("无法连接 MySQL (127.0.0.1:1/app)");
      expect(error).not.toContain("top-secret-pw");
    } finally {
      await m.closeAll();
    }
  }, 15000);

  it("Doris 连接失败时给出清晰错误（含 host:port/database，默认端口 9030）", async () => {
    const m = new ConnectionManager({
      connections: {
        bad: { type: "doris", host: "127.0.0.1", port: 1, user: "ro", password: "pw", database: "app" },
      },
      timeoutMs: 1000,
    });
    try {
      await expect(
        dorisQuery(m.dorisPool("bad"), "SELECT 1", [], { maxRows: 10, timeoutMs: 1000 }),
      ).rejects.toThrowError(/无法连接 Doris \(127\.0\.0\.1:1\/app\): connect ECONNREFUSED/);
    } finally {
      await m.closeAll();
    }
  }, 15000);
});
