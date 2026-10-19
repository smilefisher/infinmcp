// 本地平台自测（不需要任何真实数据库）：
//   node scripts/local-check.mjs
//
// 前置：先准备配置并起服务（没有配置就 cp local-test.config.example.json local-test.config.json）
//   node dist/index.js serve -c local-test.config.json -d ~/.config/infinmcp-local
//
// 可用环境变量覆盖：
//   INFINMCP_BASE=http://127.0.0.1:8787  INFINMCP_ADMIN_KEY=...  INFINMCP_USER_KEY=...
//   INFINMCP_CONFIG=<配置文件路径>（默认 local-test.config.json）
//
// Key 默认按 admin / user 角色从配置文件里自动读取，所以配置里的 Key 名换了也不用改这个脚本。
//
// 说明：数据库相关用例只验证「拦截发生在连库之前」，因此没有真库也能跑。
//       连接「测试连通性」预期失败（ECONNREFUSED），这本身就是在验证错误信息质量。

import { readFileSync } from "node:fs";

const BASE = process.env.INFINMCP_BASE ?? "http://127.0.0.1:8787";

/** 从配置文件里按角色取 Key（支持 {env:VAR} 占位符），取不到就返回 undefined。 */
function readKeysFromConfig() {
  const path = process.env.INFINMCP_CONFIG ?? "local-test.config.json";
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    const list = Array.isArray(cfg?.server?.apiKeys) ? cfg.server.apiKeys : [];
    const pick = (role) => {
      const entry = list.find((item) => item?.role === role && typeof item?.key === "string");
      if (!entry) return undefined;
      const placeholder = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(entry.key);
      return placeholder ? process.env[placeholder[1]] : entry.key;
    };
    return { path, admin: pick("admin"), user: pick("user") };
  } catch {
    return { path };
  }
}

const cfgKeys = readKeysFromConfig();
const ADMIN = process.env.INFINMCP_ADMIN_KEY ?? cfgKeys.admin ?? "local-admin-key";
const USER = process.env.INFINMCP_USER_KEY ?? cfgKeys.user ?? "local-user-key";
const KEY_SOURCE = process.env.INFINMCP_ADMIN_KEY
  ? "环境变量 INFINMCP_ADMIN_KEY"
  : cfgKeys.admin
    ? `配置文件 ${cfgKeys.path}（按 admin / user 角色自动读取）`
    : "内置默认值 local-admin-key —— 没找到配置文件，也没设环境变量";

let failures = 0;
const group = (name) => console.log(`\n【${name}】`);
const check = (label, cond, extra = "") => {
  if (!cond) failures++;
  console.log(`  ${cond ? "✅" : "❌"} ${label}${extra ? `  → ${extra}` : ""}`);
};

const auth = (key) => (key ? { authorization: `Bearer ${key}` } : {});
const json = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...auth(init.key) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, contentType: res.headers.get("content-type") ?? "" };
};

/** 调 MCP 工具（HTTP + Bearer；服务端为无状态模式，响应为 JSON）。 */
async function callTool(name, args, key = ADMIN) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...auth(key),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  const payload = contentType.includes("text/event-stream")
    ? JSON.parse(text.split("\n").find((line) => line.startsWith("data: ")).slice(6))
    : JSON.parse(text);
  return payload?.result;
}

const toolText = (result) => (result?.content ?? []).map((block) => block.text ?? "").join("\n");

async function main() {
  // 0) 服务是否在跑
  let health;
  try {
    health = await json("/healthz");
  } catch {
    console.error(`无法连接 ${BASE}，请先启动服务：\n  node dist/index.js serve -c local-test.config.json -d ~/.config/infinmcp-local\n`);
    process.exit(1);
  }
  group("0. 服务存活");
  console.log(`  服务地址: ${BASE}`);
  console.log(`  Key 来源: ${KEY_SOURCE}`);
  check("GET /healthz 免鉴权可用", health.status === 200, JSON.stringify(health.body));

  // 1) 鉴权
  group("1. API Key 鉴权");
  check("无 Key → 401", (await json("/api/state")).status === 401);
  check("错 Key → 401", (await json("/api/state", { key: "wrong" })).status === 401);
  const meAdmin = await json("/api/me", { key: ADMIN });
  check("admin 身份正确", meAdmin.body?.role === "admin", JSON.stringify(meAdmin.body));
  if (meAdmin.status === 401) {
    console.log(`     ↳ Key 不对（当前来源：${KEY_SOURCE}）。`);
    console.log("       核对配置文件里的 server.apiKeys，或用 INFINMCP_ADMIN_KEY=<Key> 指定。");
  }
  const meUser = await json("/api/me", { key: USER });
  check("user 身份正确", meUser.body?.role === "user", JSON.stringify(meUser.body));

  // 2) 状态与工具清单
  group("2. 工具与连接清单");
  const state = await json("/api/state", { key: ADMIN });
  const tools = (state.body?.tools ?? []).map((tool) => tool.name);
  check("11 个工具已注册", tools.length === 11, tools.join(", "));
  const expected = [
    "list_connections",
    "mysql_query",
    "mysql_schema",
    "doris_query",
    "doris_schema",
    "redis_exec",
    "redis_scan",
    "mongo_find",
    "mongo_aggregate",
    "mongo_list_collections",
    "mongo_schema",
  ];
  check("工具名与设计一致", expected.every((name) => tools.includes(name)));
  check("连接清单已加载", (state.body?.connections ?? []).length >= 3, `${state.body?.connections?.length} 个`);
  check("口令已脱敏（不出现明文）", !JSON.stringify(state.body).includes("fake-password"));

  // 3) 只读拦截（都在连库之前触发，无需真库）
  group("3. 只读拦截（不需要数据库）");
  const cases = [
    ["mysql_query", { connection: "main", sql: "INSERT INTO users VALUES (1)" }, /只允许只读语句/],
    ["mysql_query", { connection: "main", sql: "UPDATE users SET name='x'" }, /只允许只读语句/],
    ["mysql_query", { connection: "main", sql: "DROP TABLE users" }, /只允许只读语句/],
    ["mysql_query", { connection: "main", sql: "SELECT 1; DELETE FROM users" }, /多条语句/],
    ["redis_exec", { connection: "cache", command: "SET", args: ["k", "v"] }, /不是允许的只读命令/],
    ["redis_exec", { connection: "cache", command: "FLUSHALL" }, /不是允许的只读命令/],
    ["redis_exec", { connection: "cache", command: "KEYS", args: ["*"] }, /改用 redis_scan/],
    ["mongo_aggregate", { connection: "docs", collection: "c", pipeline: [{ $out: "x" }] }, /禁止聚合写入阶段/],
    ["mongo_find", { connection: "main", collection: "c" }, /类型是 mysql/],
    ["mysql_query", { connection: "不存在的连接", sql: "SELECT 1" }, /未知连接/],
  ];
  for (const [tool, args, pattern] of cases) {
    const result = await callTool(tool, args);
    const text = toolText(result);
    check(`${tool} ${JSON.stringify(args).slice(0, 58)}`, result?.isError === true && pattern.test(text), text.replace(/\n/g, " ").slice(0, 96));
  }

  // 4) 合法只读调用：没有真库时会走到连库失败，验证错误信息可读；配了真库时能出数，顺带验证可用
  group("4. 合法只读调用（库不可达时校验报错质量）");
  const mysqlCall = await callTool("mysql_query", { connection: "main", sql: "SELECT 1" });
  const mysqlText = toolText(mysqlCall);
  if (mysqlCall?.isError) {
    check("mysql_query 报错含目标地址", /无法连接 MySQL/.test(mysqlText), mysqlText.replace(/\n/g, " ").slice(0, 110));
  } else {
    check("mysql_query 可用（库可达，跳过报错质量校验）", true, mysqlText.replace(/\n/g, " ").slice(0, 72));
  }
  const redisCall = await callTool("redis_exec", { connection: "cache", command: "GET", args: ["k"] });
  const redisText = toolText(redisCall);
  if (redisCall?.isError) {
    check("redis_exec 报错含目标地址", /无法连接 Redis/.test(redisText), redisText.replace(/\n/g, " ").slice(0, 110));
  } else {
    check("redis_exec 可用（库可达，跳过报错质量校验）", true, redisText.replace(/\n/g, " ").slice(0, 72));
  }

  // 5) 连接管理权限分级 + 热生效
  group("5. 连接管理（权限分级 + 热生效）");
  const newConn = { type: "redis", host: "127.0.0.1", port: 6399, db: 2 };
  const putUser = await json("/api/connections/selfcheck", {
    method: "PUT",
    key: USER,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(newConn),
  });
  check("user 改连接 → 403", putUser.status === 403, putUser.body?.message);

  const putAdmin = await json("/api/connections/selfcheck", {
    method: "PUT",
    key: ADMIN,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(newConn),
  });
  check("admin 新增连接 → 200", putAdmin.status === 200, putAdmin.body?.message);

  const listAfter = await callTool("list_connections", {});
  check("MCP 立即看到新连接（热生效）", /selfcheck/.test(toolText(listAfter)));

  const testNew = await json("/api/connections/selfcheck/test", { method: "POST", key: ADMIN });
  check("测试连通性返回结构化结果（不抛 500）", testNew.status === 200 && testNew.body?.ok === false, JSON.stringify(testNew.body));

  const del = await json("/api/connections/selfcheck", { method: "DELETE", key: ADMIN });
  check("admin 删除连接 → 200", del.status === 200);
  const listFinal = await callTool("list_connections", {});
  check("删除后 MCP 立即不可见", !/selfcheck/.test(toolText(listFinal)));

  // 6) 日志
  group("6. 调用日志");
  const logs = await json("/api/logs?limit=200", { key: ADMIN });
  const entries = logs.body?.entries ?? [];
  check("日志有记录", entries.length > 0, `${entries.length} 条`);
  check("每条都有 user 归属", entries.every((entry) => typeof entry.user === "string"));
  check("记录了成功与失败两类", entries.some((e) => e.status === "ok") && entries.some((e) => e.status === "error"));
  check("user 也能看日志", (await json("/api/logs", { key: USER })).status === 200);

  // 7) Web 页面
  group("7. Web 页面与静态资源");
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  check("GET / → text/html", home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html"));
  check("含「使用说明」", html.includes("使用说明"));
  check("含只读边界说明", html.includes("只读边界"));
  check("GET /app.js 可用", (await fetch(`${BASE}/app.js`)).status === 200);
  check("GET /styles.css 可用", (await fetch(`${BASE}/styles.css`)).status === 200);
  check("路径穿越被拦", [403, 404].includes((await fetch(`${BASE}/../package.json`)).status));

  console.log(`\n${failures === 0 ? "全部通过 ✅" : `${failures} 项失败 ❌`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
