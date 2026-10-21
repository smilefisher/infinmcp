# infinmcp 设计方案

> 只读数据库 MCP 服务：支持 MySQL / Doris / Redis / MongoDB，直接以 Node 进程运行（不依赖 Docker）。
> 服务可本地或部署在测试环境，多人通过 HTTP + API Key 接入；Web 页面用于**配置连接**、**查看调用日志**，并提供**使用说明**。

## 1. 目标与非目标

### 目标
- 一个本地运行的 MCP server，向 OpenCode（及其他 MCP 客户端）暴露 **MySQL / Doris / Redis / MongoDB** 的**只读**能力。
- 支持多个连接（可同时配多个同类/不同类库），连接可在 Web 页面增删改查并即时生效。
- 提供 Web 页面：连接管理（admin）+ 调用日志（含调用者归属、实时刷新）。
- 多用户共用：API Key 分人、分角色（admin / user）。

### 非目标（本期不做）
- 任何写操作（INSERT/UPDATE/DELETE/DDL、Redis 写命令、Mongo 写/聚合写入阶段）
- 任意兜底 SQL/命令透传
- Docker 化（后续需要再补）
- OAuth（本期用 API Key）

## 2. 技术选型

| 项 | 选择 | 说明 |
|---|---|---|
| 语言/运行时 | TypeScript + Node >= 20（ESM） | |
| MCP SDK | `@modelcontextprotocol/sdk` | stdio + Streamable HTTP |
| 驱动 | `mysql2`（MySQL + Doris）/ `ioredis` / `mongodb` | |
| 校验 | `zod` | 配置与工具入参 schema |
| CLI | `commander` | 子命令 `mcp` / `serve` |
| 环境变量 | `dotenv` | 读取 `.env` |
| 构建/测试 | `tsc` + `vitest` | 产物 `dist/`，bin 名 `infinmcp` |

## 3. 运行形态

| 形态 | 命令 | 用途 |
|---|---|---|
| 主：HTTP 服务 | `node dist/index.js serve` | 长驻；多人通过 `/mcp` 接入；Web 配置即时生效 |
| 辅：stdio | `node dist/index.js mcp` | 本地单机调试，启动时读配置 |
| 不依赖 | — | 无需 Docker；README 附 systemd / pm2 启动示例 |

启动示例：

```bash
npm run build
node dist/index.js serve --config ./infinmcp.config.json
```

> 说明：MCP 走 stdio 时为独立进程，Web 上改配置不会影响该进程；「Web 配置即时生效」以 `serve` 模式为准。

## 4. 配置

配置文件查找顺序：`--config <path>` / `INFINMCP_CONFIG` → `./infinmcp.config.json` → `~/.config/infinmcp/config.json`。
敏感值支持 `{env:VAR}` 替换。JSON 格式（本期不支持注释）。

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "apiKeys": [
      { "name": "chenning", "key": "{env:KEY_CHENNING}", "role": "admin" },
      { "name": "alice",    "key": "{env:KEY_ALICE}",    "role": "user"  }
    ]
  },
  "connections": {
    "main":  { "type": "mysql",   "host": "10.0.0.11", "port": 3306, "user": "ro", "password": "{env:MYSQL_PW}", "database": "app", "env": "prod", "readonly": true },
    "warehouse": { "type": "doris", "host": "10.0.0.14", "port": 9030, "user": "ro", "password": "{env:DORIS_PW}", "database": "app", "env": "test", "readonly": true, "maxRows": 100 },
    "cache": { "type": "redis",   "host": "10.0.0.12", "port": 6379, "db": 0, "env": "dev" },
    "docs":  { "type": "mongodb", "uri": "{env:MONGO_URI}", "database": "app", "env": "dev" }
  },
  "limits": {
    "maxRows": 200,
    "timeoutMs": 10000,
    "maxCellWidth": 512,
    "inlineMaxBytes": 262144,
    "inlineMaxRows": 1000,
    "exportTtlHours": 24,
    "exportMaxFiles": 200
  },
  "logs":   { "file": "~/.infinmcp/logs.jsonl" }
}
```

- 权限：`admin` 可改连接配置；`user` 只能调用查询工具、查看日志。
- Web 保存的连接写入 `~/.config/infinmcp/connections.json`（权限 `0600`，可用 `--data-dir` 改），启动时与静态配置合并；保存后**热生效**（重建连接池）。
- 密码支持明文（本地）或 `{env:VAR}`；列表/详情接口只返回掩码，编辑留空表示保留原值。
- 连接可选标签 `env`（`prod/test/dev`）、`readonly`、`maxRows`：只做展示与行数上限，不参与路由，也不放行任何写操作；连接级 `maxRows` 只能调低全局值。

## 5. MCP 工具清单（查询工具全部只读；连接管理工具受后台开关控制）

| 工具 | 参数 | 返回 | 只读约束 |
|---|---|---|---|
| `list_connections` | — | 连接名/类型/库 + `env`/`readonly`/`maxRows` 标签 | — |
| `mysql_query` | `connection`, `sql`, `params?`, `limit?`, `columns?`, `max_cell_width?`, `output?`, `format?` | 列 + 行（或导出预览 + 下载信息） | 仅 `SELECT/SHOW/EXPLAIN/DESC/WITH(select)`；禁多语句；自动补/强制 `LIMIT`；只读事务；超时 |
| `mysql_batch_query` | `connection`, `queries[{name?, sql, params?, limit?, columns?, output?, format?}]`, `max_cell_width?` | 按 `name` 分段的结果 | 1–20 条；逐条走同一只读守卫；单条失败不中断；不开事务 |
| `mysql_schema` | `connection`, `database?`, `table?` | 库/表/列/索引 | 走 `information_schema` |
| `doris_query` | `connection`, `sql`, `params?`, `limit?`, `columns?`, `max_cell_width?`, `output?`, `format?` | 列 + 行（或导出预览） | 同 `mysql_query`（Doris 与 MySQL 协议兼容） |
| `doris_batch_query` | 同 `mysql_batch_query` | 按 `name` 分段的结果 | 同 `mysql_batch_query` |
| `doris_schema` | `connection`, `database?`, `table?` | 库/表/列/索引 | 走 `information_schema` |
| `redis_exec` | `connection`, `command`, `args`, `max_cell_width?`, `output?`, `format?` | 结果（或导出预览） | 命令白名单（GET/MGET/GETRANGE/HGET/HGETALL/HLEN/LRANGE/LLEN/SMEMBERS/SISMEMBER/SCARD/ZRANGE/ZSCORE/ZCARD/TTL/TYPE/EXISTS/DBSIZE/INFO 等）；**禁** `SET/DEL/FLUSHALL/KEYS/CONFIG` |
| `redis_scan` | `connection`, `pattern`, `cursor?`, `count?`, `type?`, `max_cell_width?`, `output?`, `format?` | key 列表 + cursor（或导出预览） | 用 `SCAN` 替代 `KEYS` |
| `mongo_find` | `connection`, `collection`, `filter?`, `projection?`, `sort?`, `limit?`, `columns?`, `max_cell_width?`, `output?`, `format?` | 文档数组（或 `documentsPreview`） | 上限 `maxRows` |
| `mongo_aggregate` | `connection`, `collection`, `pipeline`, `columns?`, `max_cell_width?`, `output?`, `format?` | 文档数组（或预览） | 禁 `$out`/`$merge` |
| `mongo_list_collections` | `connection`, `database?` | 集合名 | `listCollections` |
| `mongo_schema` | `connection`, `collection`, `sample?` | 采样推断字段/类型 | 只读采样 |
| `create_connection` | `name`, `type`, `host?`, `port?`, `user?`, `password?`, `database?`, `charset?`, `db?`, `tls?`, `uri?`, `env?`, `readonly?`, `maxRows?` | 脱敏连接信息 | **写操作**：需后台开关 + `serve` 模式 |
| `update_connection` | 同上（`type` 可省，沿用现有类型；`env`/`readonly`/`maxRows` 传 `null` 可清除） | 脱敏连接信息 | **写操作**：部分更新，未传字段保持原值 |
| `delete_connection` | `name` | 删除结果 | **写操作**：仅限 `connections.json`；不可逆 |
| `test_connection` | `name` | `ok`/`latencyMs`/`type`/`error` | 只读探测（`SELECT 1` / `PING` / `ping`），不需要开关 |

统一行为：每次调用记录 `ts / user / tool / connection / 摘要 / status / durationMs / rowCount / error`，写入 JSONL 并广播给 UI。

### 结果处理（SQL / Redis / Mongo 查询通用）

- `max_cell_width`：单值最大字符数（默认 `limits.maxCellWidth` = 512）；截断后标注「已截断」。
- `columns`：列裁剪，只对 SQL / Mongo 行结果生效；Mongo 只作用于顶层字段。
- `output`：`auto`（默认）/ `inline` / `file`；`auto` 在估算超过 `inlineMaxBytes` 或行数超过 `inlineMaxRows` 时落文件。
- `format`：`jsonl`（默认）/ `csv`。
- 导出文件写到 `<data-dir>/exports/`，保留完整值；上下文只放前 20 行/项预览与导出元信息。
  HTTP 返回 `downloadUrl`，stdio 返回 `downloadPath`。目录 `0700`、文件 `0600`，按 TTL / 最大文件数清理。

## 6. 安全模型

- 只读三层防护：入参白名单校验（`readonly.ts`）→ 驱动层限制（禁多语句、只读事务、超时）→ 结果层限额（`maxRows` / `maxCellWidth`）。
- 结果层不把超大结果直接塞进上下文：长单元格截断，超大结果导出到 `<data-dir>/exports/`；导出文件只允许本服务生成的文件名，下载需有效 API Key。
- 所有 HTTP 接口（`/mcp`、`/api/*`）强制 API Key；无/错 Key 一律 `401`。
- 连接配置写操作仅限 `role=admin`。
- AI 写连接（`create_connection` / `update_connection` / `delete_connection`）默认**关闭**，
  由 `server.allowAiConnectionWrites`（配置默认值）+ `<data-dir>/settings.json`（Web 勾选，热生效）双重来源决定；
  仅在 HTTP `serve` 模式注入该能力，stdio 模式这些工具直接报错。
- 密码/Key 不明文回显；日志不含密码。

## 7. Web 页面（同一端口）

- Tab 1「连接」：列表 + 新增/编辑/删除/重命名（支持中文）+ 测试连通性（admin 专属）；可选填 `env` / `readonly` / `maxRows`。
- Tab 2「日志」：时间 / 用户 / 工具 / 连接 / 耗时 / 行数 / 状态，支持按用户、连接、工具筛选，SSE 实时刷新。
- Tab 3「使用说明」（必需）：如何填 API Key、如何配置连接、如何把 MCP 客户端接进来（含 OpenCode / 通用 JSON 示例）、17 个工具用法与示例、只读限制与结果导出说明。
- 首次访问填写 API Key，之后记忆（localStorage）。

## 8. HTTP 接口

实际实现（第 6 步）：

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| POST | `/mcp` | MCP Streamable HTTP 端点（无状态） | user+ |
| GET | `/healthz` | 存活检查 | — |
| GET | `/api/me` | 当前身份 / 角色 | user+ |
| GET | `/api/state` | 版本 / 限制 / 脱敏连接 / 工具清单 | user+ |
| GET | `/api/connections` | 连接列表（密码掩码） | user+ |
| GET | `/api/connections/:name` | 单个连接（掩码） | user+ |
| PUT | `/api/connections/:name` | 新增 / 编辑连接；body 的 `name` 不同则重命名（支持中文，静态连接不可改名） | admin |
| DELETE | `/api/connections/:name` | 删除连接 | admin |
| POST | `/api/connections/:name/test` | 测试连通性 | admin |
| GET | `/api/exports/:file` | 下载导出文件（仅 `.jsonl` / `.csv` basename；支持 HEAD） | user+ |
| GET | `/api/settings` | 运行时设置（允许 AI 管理连接开关） | user+ |
| PUT | `/api/settings` | 修改运行时设置（热生效） | admin |
| GET | `/api/logs?limit=` | 日志查询 | user+ |
| GET | `/api/logs/stream` | 日志 SSE 实时流 | user+ |
| GET | `/` | Web 页面（静态） | — |

第 7 步补充：`POST /api/connections/:name/test`（测试连通性，admin）。
通用数据访问扩展：`GET /api/exports/:file`，文件不存在 → 404，非法文件名 / 路径穿越 → 400。

## 9. 目录结构

```
infinmcp/
├── package.json  tsconfig.json  README.md  .env.example
├── infinmcp.config.example.json
├── docs/infinmcp_design.md
├── public/index.html
└── src/
    ├── index.ts                  # CLI 入口（commander）
    ├── config.ts                 # 配置加载/校验/合并/{env:} 替换（含连接标签、limits）
    ├── auth.ts                   # 多 Key 校验 + role
    ├── logging.ts                # JSONL 落盘 + 内存环形缓冲 + SSE 广播
    ├── connectionsStore.ts       # 可写 connections.json（0600 原子写，含重命名）
    ├── settingsStore.ts          # 运行时设置 settings.json（0600 原子写）
    ├── readonly.ts               # 只读守卫（SQL / 命令 / 管道）
    ├── output.ts                 # 结果截断 / 列裁剪 / CSV/JSONL / 落文件 / 清理
    ├── runtime.ts                # 运行时配置与热更新
    ├── server.ts                 # MCP server：注册工具、统一调度与计时
    ├── http.ts                   # /mcp + /api/* + 静态页 + 导出下载
    ├── json.ts                   # JSON 安全序列化（bigint 等）
    ├── version.ts
    ├── connections/
    │   ├── manager.ts            # 按连接名懒连接/复用/重建/关闭
    │   ├── sql.ts                # MySQL 协议兼容库（MySQL / Doris）的公共实现
    │   ├── mysql.ts
    │   ├── doris.ts
    │   ├── redis.ts
    │   ├── mongodb.ts
    │   └── test.ts               # 连通性测试
    └── tools/
        ├── index.ts              # 工具注册表（17 个）
        ├── meta.ts               # list_connections
        ├── connections.ts        # create/update/delete/test_connection（受开关控制）
        ├── mysql.ts
        ├── doris.ts
        ├── sqlBatch.ts           # mysql_batch_query / doris_batch_query
        ├── redis.ts
        ├── mongodb.ts
        ├── queryOutput.ts        # SQL 行结果的统一输出处理
        └── valueOutput.ts        # Redis 非表格值的输出处理
```

## 10. OpenCode V2 接入

```jsonc
{
  "mcp": {
    "servers": {
      "infinmcp": {
        "type": "remote",
        "url": "http://<host>:8787/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:INFINMCP_API_KEY}" }
      }
    }
  }
}
```

> V2 remote 默认走 OAuth，此处 `oauth: false` 表示纯 API Key；密钥用 `{env:...}` 引用，不写进配置文件。

本地 stdio 方式（可选）：

```jsonc
{
  "mcp": {
    "servers": {
      "infinmcp": {
        "type": "local",
        "command": ["node", "/path/to/infinmcp/dist/index.js", "mcp"],
        "disabled": false
      }
    }
  }
}
```

## 11. 开发步骤

| # | 目标 | 验证方式 | 状态 |
|---|---|---|---|
| 1 | 骨架 + CLI(`mcp`/`serve`) + 配置加载校验（多 Key/role、`{env}`、可写 connections 文件）+ `.env.example` | `npm run build` 通过；`--help`；缺 Key 时 serve 明确报错 | ✅ |
| 2 | MCP 骨架（stdio/HTTP 共用注册）+ 日志模块（含 user 归属）+ `list_connections` | stdio 调通；`logs.jsonl` 含 user 字段 | ✅ |
| 3 | MySQL 只读（守卫 + `mysql_query`/`mysql_schema`） | 查询通；写语句/多语句被拒（单测） | ✅ |
| 4 | Redis 只读（`redis_exec`/`redis_scan`） | 白名单读通；`SET/DEL/FLUSHALL/KEYS` 被拒（单测） | ✅ |
| 5 | MongoDB 只读（4 个工具） | 读通；含 `$out`/`$merge` 被拒（单测） | ✅ |
| 6 | HTTP 服务 + 多 Key 鉴权（admin/user 分级、`/mcp`） | 无/错 Key→401；user 改配置→403；带 Key 可调工具 | ✅ |
| 7 | Web：连接管理（admin，热生效）+ 日志页（筛选 + SSE）+ **使用说明** | admin 加连接→MCP 即时可用；user 无配置入口；页面上能看到接入与工具用法说明 | ✅ |
| 8 | 运行/部署说明：直接运行、`.env`、systemd/pm2 示例、接入文档 | 按 README 能起服务并接入 | ✅ |
| 9 | 收尾：整体 build + 全量测试 + 文档补全 | 全绿；端到端跑通 | ✅ |
| 10 | AI 连接管理：`create/update/delete/test_connection` + 后台开关（默认关，Web 勾选，热生效） | 开关关→拒绝；开→AI 增删改连接并热生效；stdio 只读 | ✅ |
| 11 | 通用数据访问：连接标签 / 重命名、批量只读 SQL、结果截断 / 列裁剪 / 大结果导出 | 标签回显、中文改名热生效、批量单条失败不中断、`/api/exports` 下载与路径穿越防护 | ✅ |

> 已用真实 MySQL / Doris / Redis / MongoDB 实例做过手工只读验证；`INFINMCP_TEST_*` 自动化集成测试默认跳过，需显式提供实例后运行。

## 12. 默认值

1. 端口 `8787`，绑 `0.0.0.0`（供同事访问）
2. 每人一个 Key，两级权限 `admin` / `user`
3. 连接配置持久化到 `~/.config/infinmcp/connections.json`
4. 暂不做 Docker（后续需要再加）
