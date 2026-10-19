import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertValidConnectionName,
  ConnectionStoreError,
  connectionsFilePath,
  deleteConnection,
  readConnections,
  upsertConnection,
  writeConnections,
} from "../src/connectionsStore.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-store-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("connectionsStore", () => {
  it("新增并读回连接", () => {
    upsertConnection(dataDir, "main", { type: "mysql", host: "10.0.0.1", user: "ro", database: "app" });
    const connections = readConnections(dataDir);
    expect(Object.keys(connections)).toEqual(["main"]);
    expect(connections.main).toMatchObject({ type: "mysql", host: "10.0.0.1", user: "ro" });
  });

  it("落盘文件为 0600 且是合法 JSON", () => {
    upsertConnection(dataDir, "cache", { type: "redis", host: "10.0.0.2" });
    const file = connectionsFilePath(dataDir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { connections: Record<string, unknown> };
    expect(parsed.connections.cache).toMatchObject({ type: "redis", host: "10.0.0.2" });
  });

  it("省略 password 时沿用旧口令（前端无需回填密钥）", () => {
    upsertConnection(dataDir, "main", { type: "mysql", host: "h", user: "ro", password: "secret" });
    upsertConnection(dataDir, "main", { type: "mysql", host: "h2", user: "ro" });
    const connections = readConnections(dataDir);
    expect(connections.main).toMatchObject({ host: "h2", password: "secret" });
  });

  it("显式传空口令时同样沿用旧口令", () => {
    upsertConnection(dataDir, "cache", { type: "redis", host: "h", password: "secret" });
    upsertConnection(dataDir, "cache", { type: "redis", host: "h", password: "" });
    expect(readConnections(dataDir).cache).toMatchObject({ password: "secret" });
  });

  it("MongoDB 省略 uri 时沿用旧 uri", () => {
    upsertConnection(dataDir, "docs", { type: "mongodb", uri: "mongodb://u:p@h:27017/a" });
    upsertConnection(dataDir, "docs", { type: "mongodb", database: "b" });
    expect(readConnections(dataDir).docs).toMatchObject({
      uri: "mongodb://u:p@h:27017/a",
      database: "b",
    });
  });

  it("Doris 省略 password 时沿用旧口令", () => {
    upsertConnection(dataDir, "warehouse", { type: "doris", host: "h", user: "ro", password: "secret" });
    upsertConnection(dataDir, "warehouse", { type: "doris", host: "h2", user: "ro" });
    expect(readConnections(dataDir).warehouse).toMatchObject({ host: "h2", password: "secret" });
  });

  it("省略 type 时沿用旧类型", () => {
    upsertConnection(dataDir, "cache", { type: "redis", host: "h" });
    upsertConnection(dataDir, "cache", { port: 6380 });
    expect(readConnections(dataDir).cache).toMatchObject({ type: "redis", host: "h", port: 6380 });
  });

  it("删除连接", () => {
    upsertConnection(dataDir, "a", { type: "redis", host: "h" });
    upsertConnection(dataDir, "b", { type: "redis", host: "h" });
    expect(deleteConnection(dataDir, "a")).toBe(true);
    expect(deleteConnection(dataDir, "missing")).toBe(false);
    expect(Object.keys(readConnections(dataDir))).toEqual(["b"]);
  });

  it("连接名不合法时报错", () => {
    for (const bad of ["", "a b", "a/b", "a".repeat(65), "中文"]) {
      expect(() => assertValidConnectionName(bad)).toThrowError(ConnectionStoreError);
    }
    expect(() => assertValidConnectionName("app_main-1.2")).not.toThrow();
  });

  it("配置非法时报错并给出字段路径", () => {
    expect(() => upsertConnection(dataDir, "bad", { type: "mysql", host: "h" })).toThrowError(/user/);
    expect(() => upsertConnection(dataDir, "bad", { type: "nope" })).toThrowError(/type/);
    expect(() => upsertConnection(dataDir, "bad", "not-an-object")).toThrowError(/JSON 对象/);
  });

  it("文件损坏 / 缺失时容错返回空", () => {
    expect(readConnections(dataDir)).toEqual({});
    writeFileSync(connectionsFilePath(dataDir), "{ not json", "utf8");
    expect(readConnections(dataDir)).toEqual({});
    writeFileSync(connectionsFilePath(dataDir), JSON.stringify({ connections: { x: { type: "bogus" } } }), "utf8");
    expect(readConnections(dataDir)).toEqual({});
  });

  it("writeConnections 覆盖写入", () => {
    upsertConnection(dataDir, "a", { type: "redis", host: "h" });
    writeConnections(dataDir, {});
    expect(readConnections(dataDir)).toEqual({});
  });
});
