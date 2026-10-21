import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

// 入库的示例配置是「新人照着做」的入口，很容易悄悄失效（Key 改名、漏了连接、指向内网地址…）。
// 这里把它们真正加载一遍，锁住「开箱能跑」。

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "infinmcp-example-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** 读 .env.example，把里面列出的变量名都填成假值。 */
function envFromEnvExample(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const line of readFileSync(join(root, ".env.example"), "utf8").split("\n")) {
    const matched = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (matched) env[matched[1]] = matched[2] || "filled-by-test";
  }
  return env;
}

const load = (file: string, env: NodeJS.ProcessEnv = {}) =>
  loadConfig({ configPath: join(root, file), dataDir: scratch, env });

describe("入库的示例配置", () => {
  it("local-test.config.example.json 不依赖任何环境变量即可加载（本地自测开箱能跑）", () => {
    const config = load("local-test.config.example.json");
    expect(config.server.apiKeys.map((key) => key.role).sort()).toEqual(["admin", "user"]);
    expect(Object.keys(config.connections).sort()).toEqual(["cache", "docs", "main"]);
    expect(config.connections.main.type).toBe("mysql");
    expect(config.connections.cache.type).toBe("redis");
    expect(config.connections.docs.type).toBe("mongodb");
    // 本地自测只监听本机，不该暴露到局域网
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("local-test.config.example.json 不含真实口令 / 内网地址", () => {
    const text = readFileSync(join(root, "local-test.config.example.json"), "utf8");
    expect(text).toContain("fake-password");
    expect(text).not.toMatch(/\b(?:10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("infinmcp.config.example.json 的 {env:...} 占位符与 .env.example 的变量名对得上", () => {
    const config = load("infinmcp.config.example.json", envFromEnvExample());
    expect(config.server.apiKeys.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(config.connections).sort()).toEqual(["cache", "docs", "main", "warehouse"]);
    expect(config.connections.warehouse.type).toBe("doris");
    expect(config.connections.main).toMatchObject({ env: "prod", readonly: true });
    expect(config.connections.warehouse).toMatchObject({ env: "test", readonly: true, maxRows: 100 });
  });

  it("limits 的输出相关字段有默认值", () => {
    const config = load("local-test.config.example.json");
    expect(config.limits).toMatchObject({
      maxCellWidth: 512,
      inlineMaxBytes: 262144,
      inlineMaxRows: 1000,
      exportTtlHours: 24,
      exportMaxFiles: 200,
    });
  });
});
