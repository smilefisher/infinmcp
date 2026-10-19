import { describe, expect, it } from "vitest";
import { checkRedisCommand } from "../src/readonly.js";

function allowed(command: unknown, args?: unknown) {
  const result = checkRedisCommand(command, args);
  expect(result.ok, `期望允许: ${String(command)} (${result.reason})`).toBe(true);
  return result;
}

function denied(command: unknown, args?: unknown) {
  const result = checkRedisCommand(command, args);
  expect(result.ok, `期望拒绝: ${String(command)}`).toBe(false);
  return result;
}

describe("checkRedisCommand · 允许", () => {
  it("规范化命令名大小写", () => {
    const result = allowed("get", ["k"]);
    expect(result.command).toBe("GET");
    expect(result.args).toEqual(["k"]);
  });

  it("常见只读命令", () => {
    for (const [command, args] of [
      ["MGET", ["a", "b"]],
      ["HGETALL", ["h"]],
      ["LRANGE", ["l", "0", "-1"]],
      ["SMEMBERS", ["s"]],
      ["ZRANGE", ["z", "0", "-1"]],
      ["TYPE", ["k"]],
      ["TTL", ["k"]],
      ["DBSIZE", []],
      ["INFO", []],
      ["SCAN", ["0", "MATCH", "user:*"]],
      ["HSCAN", ["h", "0"]],
    ] as Array<[string, string[]]>) {
      allowed(command, args);
    }
  });

  it("把数字/布尔参数转成字符串", () => {
    expect(allowed("LRANGE", ["l", 0, -1]).args).toEqual(["l", "0", "-1"]);
  });

  it("受限子命令：MEMORY / OBJECT / XINFO / PUBSUB / COMMAND", () => {
    allowed("MEMORY", ["USAGE", "k"]);
    allowed("OBJECT", ["ENCODING", "k"]);
    allowed("XINFO", ["STREAM", "s"]);
    allowed("PUBSUB", ["CHANNELS"]);
    allowed("COMMAND", ["COUNT"]);
  });
});

describe("checkRedisCommand · 拒绝", () => {
  it("写命令与危险命令", () => {
    for (const command of [
      "SET", "DEL", "INCR", "EXPIRE", "FLUSHALL", "FLUSHDB", "CONFIG", "EVAL", "EVALSHA",
      "MULTI", "EXEC", "SORT", "BITFIELD", "GETDEL", "RESTORE", "REPLICAOF", "SHUTDOWN",
      "SCRIPT", "FUNCTION", "CLIENT", "DEBUG", "MIGRATE",
    ]) {
      denied(command, ["x"]);
    }
  });

  it("阻塞 / 订阅类命令", () => {
    for (const command of ["XREAD", "BLPOP", "BRPOP", "SUBSCRIBE", "PSUBSCRIBE", "MONITOR", "WAIT"]) {
      denied(command, ["x"]);
    }
  });

  it("KEYS 给出改用 redis_scan 的提示", () => {
    const result = denied("KEYS", ["*"]);
    expect(result.reason).toContain("redis_scan");
  });

  it("受限命令的非法子命令被拒绝", () => {
    denied("MEMORY", ["PURGE"]);
    denied("OBJECT", ["HELP"]);
    denied("XINFO", ["HELP"]);
  });

  it("参数与命令名非法", () => {
    denied("", []);
    denied("GET DATA", []); // 含空格
    denied("GET", "not-an-array");
    denied("GET", [{ bad: true }]);
  });
});
