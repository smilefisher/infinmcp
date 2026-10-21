import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import { deleteConnection, readConnections, upsertConnection } from "../src/connectionsStore.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import {
  createConnectionTool,
  deleteConnectionTool,
  testConnectionTool,
  updateConnectionTool,
} from "../src/tools/connections.js";
import type { ConnectionManageCapability, ToolContext } from "../src/tools/types.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-ctools-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * 构造最小上下文。`withManage: false` 模拟 stdio 模式（未注入连接管理能力）；
 * 注入的 upsert / remove 直接走真实的 store，等价于 HTTP 层（只是少了 runtime 热更）。
 */
function makeContext(
  connections: Record<string, ConnectionConfig>,
  opts: { enabled?: boolean; withManage?: boolean } = {},
): ToolContext {
  const manage: ConnectionManageCapability | undefined =
    opts.withManage === false
      ? undefined
      : {
          enabled: opts.enabled ?? true,
          upsert: async (name, rawConfig) => upsertConnection(dataDir, name, rawConfig),
          remove: async (name) => deleteConnection(dataDir, name),
        };
  return {
    config: { limits: { maxRows: 100, timeoutMs: 1000 } } as unknown as LoadedConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    connections: new ConnectionManager({ connections, timeoutMs: 1000 }),
    user: "tester",
    ...(manage ? { manage } : {}),
  };
}

const redisConn: ConnectionConfig = { type: "redis", host: "10.0.0.9", port: 6380, db: 1 };

describe("连接管理工具的开关与模式", () => {
  it("stdio 模式（未注入 manage）时写工具报错", async () => {
    const ctx = makeContext({}, { withManage: false });
    await expect(createConnectionTool.handler({ name: "x", type: "redis", host: "h" }, ctx)).rejects.toThrow(
      /stdio/,
    );
    await expect(updateConnectionTool.handler({ name: "x", type: "redis" }, ctx)).rejects.toThrow(/stdio/);
    await expect(deleteConnectionTool.handler({ name: "x" }, ctx)).rejects.toThrow(/stdio/);
  });

  it("后台开关关闭时写工具被拒绝", async () => {
    const ctx = makeContext({}, { enabled: false });
    await expect(createConnectionTool.handler({ name: "x", type: "redis", host: "h" }, ctx)).rejects.toThrow(
      /未开启/,
    );
  });

  it("test_connection 不受开关影响（stdio 也能用只读探测）", async () => {
    const ctx = makeContext({ cache: redisConn }, { withManage: false });
    await expect(testConnectionTool.handler({ name: "nope" }, ctx)).rejects.toThrow(/不存在/);
  });
});

describe("create_connection", () => {
  it("缺少 type 时报错", async () => {
    const ctx = makeContext({});
    await expect(createConnectionTool.handler({ name: "x", host: "h" }, ctx)).rejects.toThrow(/type/);
  });

  it("新增落盘并返回脱敏信息", async () => {
    const ctx = makeContext({});
    const result = await createConnectionTool.handler(
      { name: "report", type: "doris", host: "10.0.0.20", port: 9030, user: "ro", password: "pw", database: "app" },
      ctx,
    );
    expect(result.text).toContain("report");
    expect(result.connection).toBe("report");
    expect(readConnections(dataDir).report).toMatchObject({
      type: "doris",
      host: "10.0.0.20",
      port: 9030,
      user: "ro",
      password: "pw",
    });
    // 脱敏：structured 里不含口令明文
    expect(result.structured?.connection).toMatchObject({ name: "report", hasPassword: true });
    expect(JSON.stringify(result.structured)).not.toContain("pw");
  });

  it("Redis 的 user 参数映射为 username", async () => {
    const ctx = makeContext({});
    await createConnectionTool.handler(
      { name: "cache", type: "redis", host: "10.0.0.9", user: "acluser", db: 2 },
      ctx,
    );
    expect(readConnections(dataDir).cache).toMatchObject({ type: "redis", username: "acluser", db: 2 });
  });

  it("名称已存在时报错并提示用 update_connection", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    await expect(createConnectionTool.handler({ name: "main", type: "mysql", host: "h2", user: "ro" }, ctx)).rejects.toThrow(
      /update_connection/,
    );
  });

  it("连接名不合法时报错", async () => {
    const ctx = makeContext({});
    await expect(createConnectionTool.handler({ name: "bad/name", type: "redis", host: "h" }, ctx)).rejects.toThrow(
      /连接名不合法/,
    );
  });

  it("支持中文名与 env / readonly / maxRows 标签", async () => {
    const ctx = makeContext({});
    const result = await createConnectionTool.handler(
      {
        name: "测试环境mysql",
        type: "mysql",
        host: "h",
        user: "ro",
        env: "test",
        readonly: true,
        maxRows: 30,
      },
      ctx,
    );
    expect(result.structured?.connection).toMatchObject({
      name: "测试环境mysql",
      env: "test",
      readonly: true,
      maxRows: 30,
      maxRowsOverride: 30,
    });
    expect(readConnections(dataDir)["测试环境mysql"]).toMatchObject({
      env: "test",
      readonly: true,
      maxRows: 30,
    });
  });
});

describe("update_connection", () => {
  it("连接不存在时提示改用 create_connection", async () => {
    const ctx = makeContext({});
    await expect(updateConnectionTool.handler({ name: "ghost", type: "redis", host: "h" }, ctx)).rejects.toThrow(
      /create_connection/,
    );
  });

  it("省略 password 时沿用旧口令", async () => {
    upsertConnection(dataDir, "cache", { type: "redis", host: "h", password: "keep-me" });
    const ctx = makeContext({ cache: { type: "redis", host: "h", password: "keep-me" } });
    await updateConnectionTool.handler({ name: "cache", type: "redis", host: "h2" }, ctx);
    expect(readConnections(dataDir).cache).toMatchObject({ host: "h2", password: "keep-me" });
  });

  it("省略 type 时沿用旧类型，未传的 db 也保留", async () => {
    const ctx = makeContext({ cache: redisConn });
    await updateConnectionTool.handler({ name: "cache", port: 6400 }, ctx);
    expect(readConnections(dataDir).cache).toMatchObject({ type: "redis", host: "10.0.0.9", port: 6400, db: 1 });
  });

  // 回归：部分更新曾把未提供的字段清空（database / charset / 口令全丢）。
  it("只改端口：database / charset / 口令都不丢", async () => {
    const conn: ConnectionConfig = {
      type: "mysql",
      host: "10.0.0.1",
      port: 3306,
      user: "ro",
      password: "secret",
      database: "app",
      charset: "utf8mb4",
    };
    const ctx = makeContext({ main: conn });
    const result = await updateConnectionTool.handler({ name: "main", port: 3307 }, ctx);
    expect(result.text).toContain("3307");
    expect(readConnections(dataDir).main).toMatchObject({
      type: "mysql",
      host: "10.0.0.1",
      port: 3307,
      user: "ro",
      password: "secret",
      database: "app",
      charset: "utf8mb4",
    });
  });

  it("Redis：省略 user 保留 ACL 用户名；显式给 user 则更新", async () => {
    const ctx1 = makeContext({ cache: { type: "redis", host: "h", username: "acl", db: 3 } });
    await updateConnectionTool.handler({ name: "cache", port: 6400 }, ctx1);
    expect(readConnections(dataDir).cache).toMatchObject({ username: "acl", db: 3, port: 6400 });

    const ctx2 = makeContext({ cache: { type: "redis", host: "h", username: "acl", db: 3 } });
    await updateConnectionTool.handler({ name: "cache", user: "newuser" }, ctx2);
    expect(readConnections(dataDir).cache).toMatchObject({ username: "newuser", db: 3 });
  });

  it("MongoDB：只改 database，uri（含口令）保留", async () => {
    const uri = "mongodb://u:p@h:27017/app?authSource=admin";
    const ctx = makeContext({ docs: { type: "mongodb", uri, database: "app" } });
    await updateConnectionTool.handler({ name: "docs", database: "other" }, ctx);
    expect(readConnections(dataDir).docs).toMatchObject({ uri, database: "other" });
  });

  it("改变类型时丢弃旧类型字段", async () => {
    const ctx = makeContext({ cache: { type: "redis", host: "h", username: "acl", db: 3 } });
    await updateConnectionTool.handler(
      { name: "cache", type: "mysql", host: "h", user: "ro", database: "app" },
      ctx,
    );
    const saved = readConnections(dataDir).cache as Record<string, unknown>;
    expect(saved).toMatchObject({ type: "mysql", host: "h", user: "ro", database: "app" });
    expect(saved.db).toBeUndefined();
    expect(saved.username).toBeUndefined();
  });

  it("传 null 可清除 env / readonly / maxRows 标签", async () => {
    upsertConnection(dataDir, "cache", {
      type: "redis",
      host: "h",
      env: "prod",
      readonly: false,
      maxRows: 5,
    });
    const ctx = makeContext({
      cache: { type: "redis", host: "h", env: "prod", readonly: false, maxRows: 5 },
    });
    const result = await updateConnectionTool.handler(
      { name: "cache", env: null, readonly: null, maxRows: null },
      ctx,
    );
    const saved = readConnections(dataDir).cache as Record<string, unknown>;
    expect(saved.env).toBeUndefined();
    expect(saved.readonly).toBeUndefined();
    expect(saved.maxRows).toBeUndefined();
    expect((result.structured?.connection as Record<string, unknown>).env).toBeUndefined();
    expect((result.structured?.connection as Record<string, unknown>).readonly).toBeUndefined();
  });
});

describe("delete_connection", () => {
  it("连接不存在时报错", async () => {
    const ctx = makeContext({});
    await expect(deleteConnectionTool.handler({ name: "nope" }, ctx)).rejects.toThrow(/不存在/);
  });

  it("只存在于配置文件的连接无法删除", async () => {
    const ctx = makeContext({ main: { type: "mysql", host: "h", user: "ro" } });
    await expect(deleteConnectionTool.handler({ name: "main" }, ctx)).rejects.toThrow(/只存在于配置文件/);
  });

  it("删除 connections.json 中的连接", async () => {
    upsertConnection(dataDir, "cache", { type: "redis", host: "h" });
    const ctx = makeContext({ cache: { type: "redis", host: "h" } });
    const result = await deleteConnectionTool.handler({ name: "cache" }, ctx);
    expect(result.connection).toBe("cache");
    expect(readConnections(dataDir)).toEqual({});
  });
});

describe("test_connection", () => {
  it("连不上时返回结果而不抛错", async () => {
    const ctx = makeContext({ cache: { type: "redis", host: "127.0.0.1", port: 6399 } });
    const result = await testConnectionTool.handler({ name: "cache" }, ctx);
    expect(result.text).toContain("不可用");
    expect(result.structured).toMatchObject({ ok: false, type: "redis" });
  });
});
