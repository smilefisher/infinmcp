import { createServer, type IncomingMessage, type Server } from "node:http";
import type { ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { extractApiKey, KeyStore, type Principal } from "./auth.js";
import { ConfigError, loadConfig, safeConnectionInfo } from "./config.js";
import { testConnection } from "./connections/test.js";
import {
  CONNECTIONS_FILE,
  ConnectionStoreError,
  deleteConnection,
  upsertConnection,
} from "./connectionsStore.js";
import { diag, type Logger } from "./logging.js";
import type { Runtime } from "./runtime.js";
import { createMcpServer } from "./server.js";
import { toolDefinitions } from "./tools/index.js";
import { VERSION } from "./version.js";

/** 请求体上限：1 MiB（MCP 请求与连接配置都远小于此）。 */
const MAX_BODY_BYTES = 1 << 20;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpServerOptions {
  runtime: Runtime;
  logger: Logger;
  /** 静态资源目录；默认取仓库根下的 public/。 */
  publicDir?: string;
}

function defaultPublicDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "public");
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, `请求体过大（上限 ${MAX_BODY_BYTES} 字节）`);
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
}

function authenticate(req: IncomingMessage, keys: KeyStore): Principal | null {
  return keys.authenticate(extractApiKey(req.headers));
}

// ---------------------------------------------------------------------------
// MCP 端点（无状态：每个请求一个 server + transport，身份来自 API Key）
// ---------------------------------------------------------------------------

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  principal: Principal,
  runtime: Runtime,
  logger: Logger,
): Promise<void> {
  if (req.method !== "POST") {
    sendJson(res, 405, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Method Not Allowed（无状态模式仅支持 POST /mcp）" },
    });
    return;
  }

  const body = await readBody(req);
  const server = createMcpServer(runtime.current, logger, principal.name, runtime.manager);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

// ---------------------------------------------------------------------------
// 管理 / 展示 API
// ---------------------------------------------------------------------------

function requireAdmin(principal: Principal): void {
  if (principal.role !== "admin") {
    throw new HttpError(403, `需要 admin 权限（当前身份 ${principal.name} 为 ${principal.role}）`);
  }
}

/** 重新从磁盘加载配置并热生效（改完 connections.json 后调用）。 */
async function reloadRuntime(runtime: Runtime): Promise<void> {
  const current = runtime.current;
  const next = loadConfig({
    configPath: current.configPath ?? undefined,
    dataDir: current.dataDir,
  });
  await runtime.reload(next);
}

function publicConnections(runtime: Runtime): Array<Record<string, unknown>> {
  const connections = runtime.current.connections;
  return Object.keys(connections)
    .sort()
    .map((name) => safeConnectionInfo(name, connections[name]!) as unknown as Record<string, unknown>);
}

function handleLogsStream(req: IncomingMessage, res: ServerResponse, logger: Logger): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": connected\n\n");

  const unsubscribe = logger.subscribe((entry) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    res.write(": ping\n\n");
  }, 15000);

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  principal: Principal,
  runtime: Runtime,
  logger: Logger,
): Promise<void> {
  const method = req.method ?? "GET";
  const path = url.pathname;

  if (path === "/api/me") {
    if (method !== "GET") throw new HttpError(405, "仅支持 GET");
    sendJson(res, 200, {
      name: principal.name,
      role: principal.role,
      authRequired: new KeyStore(runtime.current.server.apiKeys).enabled,
    });
    return;
  }

  if (path === "/api/state") {
    if (method !== "GET") throw new HttpError(405, "仅支持 GET");
    const config = runtime.current;
    sendJson(res, 200, {
      version: VERSION,
      limits: config.limits,
      connections: publicConnections(runtime),
      tools: toolDefinitions.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
      })),
      dataDir: config.dataDir,
      configPath: config.configPath,
      logsFile: config.logs.file,
      warnings: config.warnings,
      mcpEndpoint: "/mcp",
    });
    return;
  }

  if (path === "/api/connections") {
    if (method !== "GET") throw new HttpError(405, "仅支持 GET；新增 / 修改请用 PUT /api/connections/<name>");
    sendJson(res, 200, { connections: publicConnections(runtime) });
    return;
  }

  if (path.startsWith("/api/connections/")) {
    const segments = path
      .slice("/api/connections/".length)
      .split("/")
      .map((segment) => decodeURIComponent(segment));
    const name = segments[0] ?? "";
    const action = segments[1];

    if (action === "test") {
      if (method !== "POST") throw new HttpError(405, "仅支持 POST");
      requireAdmin(principal);
      if (!runtime.manager.has(name)) throw new HttpError(404, `连接 "${name}" 不存在`);
      const result = await testConnection(runtime.manager, name);
      diag(
        "info",
        `${principal.name} 测试连接 "${name}"：${result.ok ? "成功" : "失败"}（${result.latencyMs}ms）`,
      );
      sendJson(res, 200, result);
      return;
    }

    if (action !== undefined) throw new HttpError(404, `未知接口: ${method} ${path}`);

    if (method === "GET") {
      const config = runtime.current.connections[name];
      if (!config) throw new HttpError(404, `连接 "${name}" 不存在`);
      sendJson(res, 200, { connection: safeConnectionInfo(name, config) });
      return;
    }

    requireAdmin(principal);

    if (method === "PUT" || method === "POST") {
      const body = await readBody(req);
      const parsed = upsertConnection(runtime.current.dataDir, name, body);
      await reloadRuntime(runtime);
      diag("info", `${principal.name} 保存了连接 "${name}" (${parsed.type})`);
      sendJson(res, 200, {
        ok: true,
        connection: safeConnectionInfo(name, parsed),
        restarted: runtime.manager.names().includes(name),
      });
      return;
    }

    if (method === "DELETE") {
      const removed = deleteConnection(runtime.current.dataDir, name);
      if (!removed) throw new HttpError(404, `连接 "${name}" 不存在于 ${CONNECTIONS_FILE}`);
      await reloadRuntime(runtime);
      diag("info", `${principal.name} 删除了连接 "${name}"`);
      sendJson(res, 200, { ok: true, deleted: name });
      return;
    }

    throw new HttpError(405, "仅支持 GET / PUT / DELETE");
  }

  if (path === "/api/logs") {
    if (method !== "GET") throw new HttpError(405, "仅支持 GET");
    const raw = Number(url.searchParams.get("limit") ?? "200");
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 1000) : 200;
    sendJson(res, 200, { entries: logger.recent(limit) });
    return;
  }

  if (path === "/api/logs/stream") {
    if (method !== "GET") throw new HttpError(405, "仅支持 GET");
    handleLogsStream(req, res, logger);
    return;
  }

  throw new HttpError(404, `未知接口: ${method} ${path}`);
}

// ---------------------------------------------------------------------------
// 静态资源（Web 页面）
// ---------------------------------------------------------------------------

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

const PLACEHOLDER_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>infinmcp</title>
<style>body{font-family:system-ui,sans-serif;max-width:44rem;margin:4rem auto;padding:0 1.5rem;line-height:1.7;color:#1f2933}code{background:#f2f4f7;padding:.15rem .35rem;border-radius:4px}</style>
</head><body>
<h1>infinmcp</h1>
<p>HTTP 服务已就绪。Web 控制台（连接配置、调用日志、使用说明）将在下一步提供。</p>
<ul>
  <li>列出能力与连接：<code>GET /api/state</code></li>
  <li>当前身份：<code>GET /api/me</code></li>
  <li>MCP 端点：<code>POST /mcp</code>（Header <code>Authorization: Bearer &lt;API Key&gt;</code>）</li>
  <li>健康检查：<code>GET /healthz</code></li>
</ul>
</body></html>
`;

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  publicDir: string,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "仅支持 GET / HEAD");

  let rel: string;
  try {
    rel = decodeURIComponent(path);
  } catch {
    throw new HttpError(400, "路径编码不合法");
  }
  if (rel === "/" || rel === "") rel = "/index.html";

  const target = normalize(join(publicDir, rel));
  if (target !== publicDir && !target.startsWith(publicDir + sep)) {
    throw new HttpError(403, "路径越界");
  }

  try {
    let filePath = target;
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = join(filePath, "index.html");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-length": data.byteLength,
      "cache-control": "no-cache",
    });
    res.end(method === "HEAD" ? undefined : data);
    return;
  } catch {
    // 落到下面的兜底
  }

  if (rel === "/index.html") {
    const html = Buffer.from(PLACEHOLDER_HTML, "utf8");
    res.writeHead(200, {
      "content-type": MIME_TYPES[".html"]!,
      "content-length": html.byteLength,
      "cache-control": "no-cache",
    });
    res.end(method === "HEAD" ? undefined : html);
    return;
  }

  throw new HttpError(404, `未找到静态资源: ${path}`);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, options: HttpServerOptions): Promise<void> {
  const { runtime, logger } = options;
  const publicDir = options.publicDir ?? defaultPublicDir();
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (path === "/healthz") {
    sendJson(res, 200, { ok: true, version: VERSION, uptimeSeconds: Math.round(process.uptime()) });
    return;
  }

  // OAuth 发现端点与动态客户端注册（DCR）：本服务用静态 API Key，不支持 OAuth。
  // 必须显式拒绝并给出可操作提示，否则请求会落到静态处理器，客户端只会看到
  // 费解的「Dynamic Client Registration rejected (HTTP 405): 仅支持 GET / HEAD」。
  if (path === "/register" || path.startsWith("/.well-known/oauth-")) {
    sendJson(res, 404, {
      error: "oauth_not_supported",
      message:
        "本服务不使用 OAuth，请改用静态 API Key：在 MCP 客户端里配置请求头 " +
        "Authorization: Bearer <API Key>（Claude Code 用 claude mcp add 的 --header 参数）。" +
        "详见服务主页的「使用说明」。",
    });
    return;
  }

  if (path === "/mcp") {
    const keys = new KeyStore(runtime.current.server.apiKeys);
    const principal = authenticate(req, keys);
    if (!principal) {
      sendJson(res, 401, {
        error: "unauthorized",
        message: "缺少或无效的 API Key（请用 Authorization: Bearer <key> 或 X-API-Key: <key>）",
      });
      return;
    }
    await handleMcp(req, res, principal, runtime, logger);
    return;
  }

  if (path === "/api" || path.startsWith("/api/")) {
    const keys = new KeyStore(runtime.current.server.apiKeys);
    const principal = authenticate(req, keys);
    if (!principal) {
      sendJson(res, 401, {
        error: "unauthorized",
        message: "缺少或无效的 API Key（请用 Authorization: Bearer <key> 或 X-API-Key: <key>）",
      });
      return;
    }
    await handleApi(req, res, url, principal, runtime, logger);
    return;
  }

  await serveStatic(req, res, path, publicDir);
}

/** 创建 HTTP 服务（MCP + 管理 API + Web 静态资源）。 */
export function createHttpServer(options: HttpServerOptions): Server {
  const server = createServer((req, res) => {
    handle(req, res, options).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: "request_error", message: error.message });
        return;
      }
      if (error instanceof ConnectionStoreError || error instanceof ConfigError) {
        sendJson(res, 400, { error: "invalid_config", message: error.message });
        return;
      }
      diag("error", `HTTP 处理失败: ${(error as Error)?.stack ?? String(error)}`);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: "internal_error", message: "服务内部错误" });
    });
  });
  return server;
}
