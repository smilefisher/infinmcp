import { describe, expect, it } from "vitest";
import { extractApiKey, KeyStore, safeEqual } from "../src/auth.js";

const keys = new KeyStore([
  { name: "chenning", key: "admin-key-123", role: "admin" },
  { name: "alice", key: "user-key-456", role: "user" },
]);

describe("extractApiKey", () => {
  it("支持 Authorization: Bearer", () => {
    expect(extractApiKey({ authorization: "Bearer abc" })).toBe("abc");
    expect(extractApiKey({ authorization: "bearer   abc  " })).toBe("abc");
  });

  it("支持 X-API-Key", () => {
    expect(extractApiKey({ "x-api-key": "abc" })).toBe("abc");
    expect(extractApiKey({ "x-api-key": "   " })).toBeUndefined();
  });

  it("同名头出现多次时取第一个", () => {
    expect(extractApiKey({ authorization: ["Bearer a", "Bearer b"] })).toBe("a");
  });

  it("缺失或非 Bearer 方案时返回 undefined", () => {
    expect(extractApiKey({})).toBeUndefined();
    expect(extractApiKey({ authorization: "Basic xyz" })).toBeUndefined();
    expect(extractApiKey({ authorization: "Bearer" })).toBeUndefined();
  });
});

describe("KeyStore", () => {
  it("解析身份与角色", () => {
    expect(keys.authenticate("admin-key-123")).toEqual({ name: "chenning", role: "admin" });
    expect(keys.authenticate("user-key-456")).toEqual({ name: "alice", role: "user" });
  });

  it("错误 / 空 Key 返回 null", () => {
    expect(keys.authenticate("wrong")).toBeNull();
    expect(keys.authenticate(undefined)).toBeNull();
    expect(keys.authenticate("")).toBeNull();
  });

  it("Key 大小写敏感", () => {
    expect(keys.authenticate("ADMIN-KEY-123")).toBeNull();
  });

  it("enabled / size", () => {
    expect(keys.enabled).toBe(true);
    expect(keys.size).toBe(2);
    expect(new KeyStore([]).enabled).toBe(false);
  });
});

describe("safeEqual", () => {
  it("相等 / 不等 / 长度不同", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
