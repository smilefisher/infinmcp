import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connectionsFilePath, readConnections } from "../src/connectionsStore.js";
import { createHttpServer } from "../src/http.js";
import { Logger } from "../src/logging.js";
import { Runtime } from "../src/runtime.js";

const ADMIN_KEY = "admin-key-test";
const USER_KEY = "user-key-test";

let dataDir: string;
let runtime: Runtime;
let logger: Logger;
let server: Server;
let base: string;
let port: number;

type Json = Record<string, unknown> | undefined;

function keyHeaders(key: string | undefined, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = { ...extra };
  if (key) out.authorization = `Bearer ${key}`;
  return out;
}

async function call(
  path: string,
  init: { method?: string; key?: string; body?: unknown } = {},
): Promise<{ status: number; text: string; json: Json; contentType: string }> {
  const method = init.method ?? "GET";
  const headers = keyHeaders(init.key, init.body === undefined ? {} : { "content-type": "application/json" });
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json, contentType: res.headers.get("content-type") ?? "" };
}

async function mcp(payload: unknown, key: string | undefined): Promise<{ status: number; json: Json; text: string }> {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: keyHeaders(key, { "content-type": "application/json", accept: "application/json, text/event-stream" }),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json: Json;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

function mcpCall(id: number, method: string, params: unknown): unknown {
  return { jsonrpc: "2.0", id, method, params };
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-http-"));
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      server: {
        host: "127.0.0.1",
        port: 8787,
        apiKeys: [
          { name: "chenning", key: ADMIN_KEY, role: "admin" },
          { name: "alice", key: USER_KEY, role: "user" },
        ],
      },
      connections: {
        main: { type: "mysql", host: "10.0.0.1", user: "ro", password: "secret", database: "app" },
      },
      limits: { maxRows: 10, timeoutMs: 1000 },
      logs: { file: join(dataDir, "logs.jsonl") },
    }),
    "utf8",
  );

  const config = loadConfig({ configPath: join(dataDir, "config.json"), dataDir });
  runtime = new Runtime(config);
  logger = new Logger({ file: config.logs.file });
  server = createHttpServer({ runtime, logger, publicDir: join(dataDir, "public") });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("健康检查与鉴权", () => {
  it("GET /healthz 无需 API Key", async () => {
    const res = await call("/healthz");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });
  });

  it("管理 API 缺 Key 返回 401", async () => {
    expect((await call("/api/me")).status).toBe(401);
    expect((await call("/api/state", { key: "wrong-key" })).status).toBe(401);
    expect((await call("/api/logs")).status).toBe(401);
  });

  it("MCP 缺 Key 返回 401", async () => {
    const res = await mcp(mcpCall(1, "tools/list", {}), undefined);
    expect(res.status).toBe(401);
  });

  it("GET /api/me 返回身份与角色", async () => {
    expect((await call("/api/me", { key: ADMIN_KEY })).json).toMatchObject({ name: "chenning", role: "admin" });
    expect((await call("/api/me", { key: USER_KEY })).json).toMatchObject({ name: "alice", role: "user" });
  });

  it("也支持 X-API-Key 头", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { "x-api-key": USER_KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "alice" });
  });
});

describe("查看连接", () => {
  it("GET /api/state 暴露工具、限制与脱敏连接", async () => {
    const res = await call("/api/state", { key: USER_KEY });
    expect(res.status).toBe(200);
    const json = res.json as Record<string, unknown>;
    expect(json.version).toBeTruthy();
    expect((json.tools as Array<{ name: string }>).map((t) => t.name)).toContain("mysql_query");
    expect((json.tools as Array<{ name: string }>).map((t) => t.name)).toContain("doris_query");
    expect(json.mcpEndpoint).toBe("/mcp");
    const connections = json.connections as Array<Record<string, unknown>>;
    expect(connections[0]).toMatchObject({ name: "main", type: "mysql", hasPassword: true });
  });

  it("绝不回传口令明文", async () => {
    const res = await call("/api/connections", { key: USER_KEY });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("secret");
    expect(res.text).not.toContain("password\"");
  });
});

describe("修改连接的权限", () => {
  it("user 角色不能新增 / 修改 / 删除（403）", async () => {
    const put = await call("/api/connections/extra", {
      method: "PUT",
      key: USER_KEY,
      body: { type: "redis", host: "10.0.0.9" },
    });
    expect(put.status).toBe(403);
    expect(put.json).toMatchObject({ error: "request_error" });

    const del = await call("/api/connections/main", { method: "DELETE", key: USER_KEY });
    expect(del.status).toBe(403);
    expect(readConnections(dataDir)).toEqual({});
  });
});

describe("admin 修改连接", () => {
  it("PUT 新增连接：落盘 + 热生效", async () => {
    const res = await call("/api/connections/extra", {
      method: "PUT",
      key: ADMIN_KEY,
      body: { type: "redis", host: "10.0.0.9", port: 6380, db: 1 },
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: true });

    expect(readConnections(dataDir).extra).toMatchObject({ type: "redis", host: "10.0.0.9", port: 6380 });
    expect(runtime.manager.names()).toContain("extra");

    const state = await call("/api/state", { key: USER_KEY });
    const names = (state.json as { connections: Array<{ name: string }> }).connections.map((c) => c.name);
    expect(names).toEqual(["extra", "main"]);
  });

  it("省略口令时沿用旧口令", async () => {
    await call("/api/connections/app2", {
      method: "PUT",
      key: ADMIN_KEY,
      body: { type: "mysql", host: "10.0.0.3", user: "ro", password: "keep-me" },
    });
    const res = await call("/api/connections/app2", {
      method: "PUT",
      key: ADMIN_KEY,
      body: { type: "mysql", host: "10.0.0.4", user: "ro" },
    });
    expect(res.status).toBe(200);
    expect(readConnections(dataDir).app2).toMatchObject({ host: "10.0.0.4", password: "keep-me" });
  });

  it("配置非法 / 连接名非法返回 400", async () => {
    expect(
      (await call("/api/connections/bad", { method: "PUT", key: ADMIN_KEY, body: { type: "mysql", host: "h" } })).status,
    ).toBe(400);
    expect(
      (await call("/api/connections/bad name", { method: "PUT", key: ADMIN_KEY, body: { type: "redis", host: "h" } }))
        .status,
    ).toBe(400);
  });

  it("DELETE 删除连接；再次删除返回 404", async () => {
    expect((await call("/api/connections/extra", { method: "DELETE", key: ADMIN_KEY })).status).toBe(200);
    expect(runtime.manager.names()).not.toContain("extra");
    expect((await call("/api/connections/extra", { method: "DELETE", key: ADMIN_KEY })).status).toBe(404);
  });

  it("单查连接：存在 200 / 不存在 404", async () => {
    expect((await call("/api/connections/main", { key: USER_KEY })).json).toMatchObject({
      connection: { name: "main", type: "mysql" },
    });
    expect((await call("/api/connections/nope", { key: USER_KEY })).status).toBe(404);
  });
});

describe("MCP over HTTP", () => {
  it("initialize / tools/list / tools/call 全链路", async () => {
    const init = await mcp(
      mcpCall(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      }),
      USER_KEY,
    );
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ result: { serverInfo: { name: "infinmcp" } } });

    const list = await mcp(mcpCall(2, "tools/list", {}), USER_KEY);
    const names = (list.json as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names).toContain("list_connections");
    expect(names).toContain("mysql_query");
    expect(names).toContain("redis_exec");
    expect(names).toContain("mongo_aggregate");

    const invoked = await mcp(
      mcpCall(3, "tools/call", { name: "list_connections", arguments: {} }),
      USER_KEY,
    );
    const text = (invoked.json as { result: { content: Array<{ text: string }> } }).result.content[0]!.text;
    expect(text).toContain("main");
    expect(text).not.toContain("secret");
  });

  it("GET /mcp 返回 405（无状态模式仅支持 POST）", async () => {
    const res = await call("/mcp", { key: USER_KEY });
    expect(res.status).toBe(405);
  });
});

describe("调用日志", () => {
  it("工具调用被记录，并可按 user 归属查询", async () => {
    await mcp(mcpCall(10, "tools/call", { name: "list_connections", arguments: {} }), ADMIN_KEY);
    const res = await call("/api/logs?limit=50", { key: ADMIN_KEY });
    expect(res.status).toBe(200);
    const entries = (res.json as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries.some((e) => e.user === "chenning" && e.tool === "list_connections")).toBe(true);
  });

  it("SSE 实时推送新日志", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/logs/stream`, {
      headers: keyHeaders(USER_KEY),
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";

    const readSome = async (ms: number): Promise<void> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("SSE 读取超时")), ms);
          }),
        ]);
        if (!result.done && result.value) acc += decoder.decode(result.value, { stream: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    try {
      await readSome(3000);
      expect(acc).toContain(": connected");

      await mcp(mcpCall(11, "tools/call", { name: "list_connections", arguments: {} }), USER_KEY);

      for (let i = 0; i < 5 && !acc.includes("list_connections"); i += 1) {
        await readSome(2000);
      }
      expect(acc).toContain("data: ");
      expect(acc).toContain('"tool":"list_connections"');
      expect(acc).toContain('"user":"alice"');
    } finally {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    }
  }, 20000);
});

describe("测试连通性", () => {
  it("user 角色不能测试（403）", async () => {
    const res = await call("/api/connections/main/test", { method: "POST", key: USER_KEY });
    expect(res.status).toBe(403);
  });

  it("连接不存在返回 404", async () => {
    const res = await call("/api/connections/nope/test", { method: "POST", key: ADMIN_KEY });
    expect(res.status).toBe(404);
  });

  it("admin 能测试；连不上时返回 ok:false + 原因（不抛 500）", async () => {
    const res = await call("/api/connections/main/test", { method: "POST", key: ADMIN_KEY });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ ok: false, type: "mysql" });
    expect(String((res.json as { error?: string }).error)).toMatch(/ECONNREFUSED|connect/i);
    expect(typeof (res.json as { latencyMs?: number }).latencyMs).toBe("number");
  });
});

describe("静态资源与安全", () => {
  it("未部署页面时首页返回占位 HTML", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.text).toContain("infinmcp");
  });

  it("真实 public/ 目录能提供页面与静态资源", async () => {
    const publicDir = fileURLToPath(new URL("../public", import.meta.url));
    const server2 = createHttpServer({ runtime, logger, publicDir });
    await new Promise<void>((resolve) => server2.listen(0, "127.0.0.1", () => resolve()));
    const port2 = (server2.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port2}`;
    try {
      const home = await fetch(`${origin}/`);
      expect(home.status).toBe(200);
      expect(home.headers.get("content-type")).toContain("text/html");
      const html = await home.text();
      expect(html).toContain("使用说明");
      expect(html).toContain("mongo_aggregate");
      expect(html).toContain("Authorization: Bearer");
      // 客户端接入说明（OpenCode / Claude Code / stdio）
      expect(html).toContain("Claude Code");
      expect(html).toContain("claude mcp add --transport http");
      expect(html).toContain("claude mcp list");
      expect(html).toContain("opencode mcp add infinmcp --global");
      // 连接配置说明（每种库的字段）
      expect(html).toContain("每种数据库要填什么");
      expect(html).toContain("utf8mb4");
      expect(html).toContain("authSource=admin");
      expect(html).toContain("doris_query");
      expect(html).toContain("9030");
      expect(html).toContain("limits.maxRows");
      // 客户端接入：改哪个文件 / 作用域
      expect(html).toContain("先看：改的是哪个文件");
      expect(html).toContain("~/.claude.json");
      expect(html).toContain("docs/clients.md");

      const js = await fetch(`${origin}/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("javascript");

      const css = await fetch(`${origin}/styles.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");

      const missing = await fetch(`${origin}/nope.txt`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it("拒绝路径穿越", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port, path: "/%2e%2e/%2e%2e/etc/passwd", method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect([403, 404]).toContain(status);
  });

  it("未知 API 返回 404", async () => {
    expect((await call("/api/nope", { key: USER_KEY })).status).toBe(404);
  });

  // Claude Code 拿到 401 后会去试 OAuth（探测 /.well-known/* 与 DCR /register）。
  // 这些路径必须给出可操作提示，否则会落到静态处理器报出「仅支持 GET / HEAD」。
  it("OAuth 发现端点与动态客户端注册被明确拒绝", async () => {
    const dcr = await call("/register", { method: "POST", body: {} });
    expect(dcr.status).toBe(404);
    expect(dcr.json?.error).toBe("oauth_not_supported");
    expect(String(dcr.json?.message)).toContain("Bearer");

    const wk = await call("/.well-known/oauth-protected-resource");
    expect(wk.status).toBe(404);
    expect(wk.json?.error).toBe("oauth_not_supported");

    const as = await call("/.well-known/oauth-authorization-server");
    expect(as.status).toBe(404);
    expect(as.json?.error).toBe("oauth_not_supported");
  });
});
