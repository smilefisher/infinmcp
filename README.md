# infinmcp

只读数据库 MCP 服务：支持 **MySQL / Doris / Redis / MongoDB**，直接以 Node 进程运行（不依赖 Docker）。
可本地运行，也可部署在测试环境，多人通过 HTTP + API Key 接入；Web 页面用于配置连接与查看调用日志。

> 文档：[设计文档](docs/infinmcp_design.md) · [客户端接入指南](docs/clients.md) · [连接配置指南](docs/connections.md) · [运行与部署](docs/deploy.md)

## 状态

开发步骤已全部完成（1–9 步）：

- [x] 第 1 步：项目骨架、CLI（`config` / `mcp` / `serve`）、配置加载与校验
- [x] 第 2 步：MCP server 骨架（stdio）+ 日志模块（含 user 归属）+ `list_connections`
- [x] 第 3 步：MySQL 只读（连接管理 + 只读守卫 + `mysql_query` / `mysql_schema`）
- [x] 第 4 步：Redis 只读（命令白名单 + `redis_exec` / `redis_scan`）
- [x] 第 5 步：MongoDB 只读（结构守卫 + `mongo_find` / `mongo_aggregate` / `mongo_list_collections` / `mongo_schema`）
- [x] 第 6 步：HTTP 服务 + API Key 鉴权（`serve`、`POST /mcp`、admin/user 角色、连接热更新、日志 SSE）
- [x] 第 7 步：Web 页面（连接管理、调用日志实时刷新、**使用说明**、连通性测试）
- [x] 第 8–9 步：运行/部署说明（[`docs/deploy.md`](docs/deploy.md)）与收尾
- [x] 补充：Doris 只读支持（`type: "doris"` + `doris_query` / `doris_schema`，复用 MySQL 协议驱动）
- [x] 补充：AI 连接管理（`create_connection` / `update_connection` / `delete_connection` / `test_connection`；受后台开关控制，默认关闭）
- [x] 补充：连接标签（`env` / `readonly` / `maxRows`）与 Web 端连接重命名（支持中文，如「测试环境mysql」）
- [x] 补充：结果处理（长文本/长 JSON 截断、`columns` 列裁剪、大结果自动导出 CSV / JSONL 并返回下载地址）
- [x] 补充：命名批量只读查询（`mysql_batch_query` / `doris_batch_query`，一次调用多条 SQL，逐条返回）

> 已用真实 MySQL / Doris / Redis / MongoDB 实例做过手工只读验证。自动化集成测试默认跳过，指定实例后见下方「测试」一节的 `INFINMCP_TEST_*`。

## 已实现的工具

| 工具 | 说明 |
| --- | --- |
| `list_connections` | 列出可用连接（脱敏），并显示可选标签 `env` / `readonly` / `maxRows` |
| `mysql_query` | 只读 SQL（仅单条 SELECT/SHOW/EXPLAIN/DESC/WITH；禁多语句与写操作）；支持 `columns` / `max_cell_width` / `output` / `format` |
| `mysql_batch_query` | MySQL 批量只读 SQL（1–20 条，按 `name` 分段返回；单条失败不中断） |
| `mysql_schema` | 查看库 / 表 / 列 / 索引 |
| `doris_query` | Doris 只读 SQL（Doris 与 MySQL 协议兼容，规则同 `mysql_query`）；输出参数同上 |
| `doris_batch_query` | Doris 批量只读 SQL（规则同 `mysql_batch_query`） |
| `doris_schema` | 查看 Doris 库 / 表 / 列 / 索引 |
| `redis_exec` | Redis 只读命令（白名单；禁写命令与阻塞命令）；支持 `max_cell_width` / `output` / `format` |
| `redis_scan` | 基于 SCAN 的 key 扫描（替代 KEYS）；输出参数同上 |
| `mongo_find` | MongoDB 只读查询（filter / projection / sort / skip / limit；禁 `$where`）；支持 `columns` / `max_cell_width` / `output` / `format` |
| `mongo_aggregate` | 只读聚合管道（禁 `$out` / `$merge` 与 `$where` / `$function` / `$accumulator`）；输出参数同上 |
| `mongo_list_collections` | 列出集合；无默认库时列出所有数据库 |
| `mongo_schema` | 采样文档推断字段路径与 BSON 类型 |
| `create_connection` | 新增数据库连接并立即生效（需管理员在 Web 控制台开启「允许 AI 管理连接」） |
| `update_connection` | 更新连接（部分更新：只传要改的字段，未传的保持原值；省略 `password` / `uri` 也沿用旧值） |
| `delete_connection` | 删除连接（不可逆；仅限 `connections.json` 中的连接） |
| `test_connection` | 测试连接连通性（只读探测，不需要开关） |

### 批量查询与结果处理

**批量查询**：`mysql_batch_query` / `doris_batch_query` 一次可跑 1–20 条只读 SQL，
每条用 `name` 命名（缺省 `q1..qN`），结果按名字分段返回；单条失败不影响其他条目。
每条还支持 `params` / `limit` / `columns` / `output` / `format`。

```jsonc
{
  "connection": "main",
  "queries": [
    { "name": "count", "sql": "SELECT COUNT(*) AS n FROM users" },
    { "name": "recent", "sql": "SELECT id, name FROM users ORDER BY id DESC LIMIT 5" }
  ]
}
```

**结果处理**（对 SQL / Redis / Mongo 查询工具通用）：

- `max_cell_width`：单值最大字符数，默认取 `limits.maxCellWidth`（512）；超出部分截断并标注「已截断」。
- `columns`：只保留指定列（SQL / Mongo 行结果；Mongo 只作用于顶层字段，嵌套字段用 `projection`）。
- `output`：`auto`（默认，超过阈值自动落文件）/ `inline`（始终直接返回）/ `file`（始终落文件）。
- `format`：落文件时的格式，`jsonl`（默认）或 `csv`。
- 落文件时**文件里保留完整值**，只有直接返回和预览按 `max_cell_width` 截断；`structuredContent` 只带前 20 行/项预览。
- HTTP 模式返回 `downloadUrl`（`GET /api/exports/<file>`）；stdio 模式返回 `downloadPath` 与服务端绝对路径。
- 导出文件在 `<data-dir>/exports/`，目录 `0700`、文件 `0600`，按 `limits.exportTtlHours` / `limits.exportMaxFiles` 清理。

## 测试

```bash
npm test        # 单测 + stdio 端到端（自动先构建）
```

真实集成测试默认跳过，指定实例后运行：

```bash
INFINMCP_TEST_MYSQL='mysql://user:pass@127.0.0.1:3306/mysql' \
INFINMCP_TEST_DORIS='doris://user:pass@127.0.0.1:9030/app' \
INFINMCP_TEST_REDIS='redis://127.0.0.1:6379/0' \
INFINMCP_TEST_MONGO='mongodb://127.0.0.1:27017/test' \
npm test
```

### 本地自测（不需要任何数据库）

平台功能（鉴权分级、连接增删改热生效、只读拦截、日志归属、Web 页面）都不依赖真实数据库——
只读拦截发生在连库之前，所以没有库也能验证。仓库里带了一份自测脚本和一份**无密配置模板**：

```bash
# 1) 准备配置（模板不含任何真实口令，Key 固定为 local-admin-key / local-user-key）
cp local-test.config.example.json local-test.config.json

# 2) 起服务（127.0.0.1:8787）
node dist/index.js serve -c local-test.config.json -d ~/.config/infinmcp-local

# 3) 另开一个终端跑自测（50+ 项检查）
node scripts/local-check.mjs
```

`local-check.mjs` **会自己从配置文件里按 admin / user 角色读 Key**，所以配置里的 Key 改成什么都不用同步脚本；
需要时可用 `INFINMCP_ADMIN_KEY` / `INFINMCP_USER_KEY` / `INFINMCP_BASE` / `INFINMCP_CONFIG` 覆盖。

浏览器打开 <http://127.0.0.1:8787/>，用配置里的 admin / user Key 进入。

第 4 节按「连接到底通不通」自适应，两种情况都应该是 **全部通过 ✅**：

| 连接指向 | 第 4 节校验什么 |
| --- | --- |
| 本机不存在的库（模板默认） | 连不上时的**报错质量**，如 `无法连接 MySQL (127.0.0.1:3306/app): connect ECONNREFUSED` |
| 真实可达的库 | **能正常查得出数**，自动跳过报错质量校验 |

> `local-test.config.json` 含明文口令，已加入 `.gitignore`，**不在仓库里**；
> 入库的模板是 `local-test.config.example.json`（不含任何真实口令）。

## 快速开始

```bash
npm install
npm run build

# 复制并编辑示例配置 / 环境变量
cp infinmcp.config.example.json infinmcp.config.json
cp .env.example .env

# 查看解析后的配置（脱敏）—— 确认 Key、连接、限制都对
node dist/index.js config
```

**跑起来**（两种模式二选一）：

```bash
# A) HTTP 模式：Web 页面 + 多人接入，浏览器打开 http://127.0.0.1:8787/
node dist/index.js serve -c infinmcp.config.json      # 不加 -c 则读 ./infinmcp.config.json

# B) stdio 模式：本机 MCP 客户端直连，不开端口、不校验 Key
node dist/index.js mcp -c infinmcp.config.json
```

### 用脚本启动（推荐日常使用）

仓库根目录的 `startup.sh` 会把「编译检查 → 后台启动 → 写 pid → 等健康检查」一次做完，并支持 stop / status / restart：

```bash
./startup.sh            # 启动（等价于 start）
./startup.sh status     # 看 pid、健康检查、MCP 端点
./startup.sh restart
./startup.sh stop
```

默认自动选用 `infinmcp.config.json`（没有则用 `local-test.config.json`），数据目录跟着配置走
（`local-test.config.json` → `~/.config/infinmcp-local`，其余 → `~/.config/infinmcp`），
可用 `INFINMCP_CONFIG` / `INFINMCP_DATA_DIR` / `INFINMCP_HOST` / `INFINMCP_PORT` 覆盖。
生产环境建议用 systemd 常驻（见 [运行与部署](docs/deploy.md)）。

几个容易踩的点：

- **`-d, --data-dir` 决定 `connections.json` 存在哪**。Web 上新建/修改的连接写在这个目录里，
  同名连接会**覆盖**配置文件里的。不传则用默认的 `~/.config/infinmcp`；
  一旦换过 `-d`，之前在 Web 上配的连接就像"不见了"（其实还躺在旧目录里）。
- **`npm start` 等价于 `node dist/index.js`**，要带参数得加 `--`：
  `npm start -- serve -c infinmcp.config.json`。
- **改了 `src/` 必须重新 `npm run build`**，`node dist/...` 才会生效；
  不想每次编译就用 `npm run dev -- serve -c infinmcp.config.json`（`tsx` 直接跑源码）。
- 换端口 / 监听地址：`-p 8799 -H 0.0.0.0`。前台运行 `Ctrl+C` 停，
  后台运行（`nohup ... &`）用 `kill` 停。详见 [运行与部署](docs/deploy.md)。

## CLI

| 命令 | 说明 |
| --- | --- |
| `infinmcp config` | 加载并打印配置摘要（脱敏） |
| `infinmcp mcp` | 以 stdio 方式运行 MCP 服务（本地调试） |
| `infinmcp serve` | 以 HTTP 方式运行 MCP 服务 + Web 页面（多人接入） |

通用参数：`-c, --config <path>`、`-d, --data-dir <path>`。
`serve` 额外支持 `-H, --host <host>`、`-p, --port <port>`（覆盖配置）。

## HTTP 接入（serve 模式）

```bash
npm run build
node dist/index.js serve -c infinmcp.config.json      # 需至少配置一个 API Key
```

启动后：

| 端点 | 鉴权 | 说明 |
| --- | --- | --- |
| `POST /mcp` | 需要 | MCP Streamable HTTP（无状态；每个请求独立） |
| `GET /healthz` | 不需要 | 存活检查 |
| `GET /api/me` | 需要 | 当前身份与角色 |
| `GET /api/state` | 需要 | 版本、限制、脱敏连接、工具清单 |
| `GET /api/connections` | 需要 | 连接列表（脱敏） |
| `GET /api/connections/<name>` | 需要 | 单个连接（脱敏） |
| `PUT /api/connections/<name>` | **admin** | 新增 / 更新连接（落盘并热生效） |
| `DELETE /api/connections/<name>` | **admin** | 删除连接 |
| `POST /api/connections/<name>/test` | **admin** | 测试连通性（MySQL / Doris `SELECT 1` / Redis `PING` / Mongo `ping`） |
| `GET /api/settings` | 需要 | 运行时设置（当前只有「允许 AI 管理连接」开关） |
| `PUT /api/settings` | **admin** | 修改运行时设置（落盘 `settings.json` 并热生效） |
| `GET /api/logs?limit=200` | 需要 | 最近的调用日志 |
| `GET /api/logs/stream` | 需要 | 调用日志 SSE 实时推送 |
| `GET /api/exports/<file>` | 需要 | 下载大结果导出文件（仅 `.jsonl` / `.csv`；任意有效 Key） |
| `GET /` | 不需要 | Web 页面（`public/`） |

鉴权：`Authorization: Bearer <API Key>` 或 `X-API-Key: <API Key>`。
不接受把 Key 放在查询参数里（避免 Key 落进 URL / 访问日志）。

角色：`admin` 可改连接；`user` 只能查询与查看日志。

### 接入 MCP 客户端

> 示例里的占位符都要替换：`<测试机>` → 实际地址（本机用 `127.0.0.1`）。**尖括号不是合法主机名**，原样保留会报 `ENOTFOUND`；
> `8787` 是默认端口（改过要跟着改）；`/mcp` 是固定路径（别丢）。`${VAR}` / `{env:VAR}` 可以保留并设置同名环境变量，也可以直接填明文 Key。

**先看改哪个文件：**

| 客户端 | 命令 | 写入的文件 | 生效范围 |
| --- | --- | --- | --- |
| Claude Code | `claude mcp add … --scope user` | `~/.claude.json` 顶层 `mcpServers` | 所有项目 |
| Claude Code | `… --scope local`（默认） | `~/.claude.json` → `projects["<目录>"].mcpServers` | 仅该目录 |
| Claude Code | `… --scope project` | 项目根目录 `.mcp.json` | 该项目（**可提交**） |
| OpenCode V2 | `opencode mcp add … --global` | `~/.config/opencode/opencode.json` | 所有项目 |
| OpenCode V2 | `opencode mcp add …`（不加 `--global`） | 当前项目 `opencode.json` | 该项目 |

> ⚠️ `project` / 项目级作用域会把 **API Key 明文写进项目文件**。项目要进 git 就改用 `user` / `--global`。

**Claude Code**

```bash
# 推荐：user 作用域 —— 所有项目都能用，且不会把 Key 写进仓库
claude mcp add --transport http infinmcp http://<测试机>:8787/mcp \
  --header "Authorization: Bearer <API Key>" --scope user

# 只给当前目录用（默认）：去掉 --scope
# 团队共享（写进项目根目录 .mcp.json，注意 Key 会随之进版本库）：--scope project

claude mcp list                            # 验证：期望 ✔ Connected
claude mcp remove infinmcp --scope user    # 移除
```

> **加完要新开一个会话**才生效（MCP server 在会话启动时加载）。
> 工具名会带前缀：`mcp__infinmcp__mysql_query`、`mcp__infinmcp__mysql_schema` …

或手写项目根目录的 `.mcp.json`（`type` 必须写 `"http"`，只给 `url` 会被当成 stdio 跳过）：

```jsonc
{
  "mcpServers": {
    "infinmcp": {
      "type": "http",
      "url": "http://<测试机>:8787/mcp",
      "headers": { "Authorization": "Bearer ${INFINMCP_API_KEY}" }
    }
  }
}
```

验证：`claude mcp list` 看到 `✔ Connected`，或会话里输入 `/mcp`。

**OpenCode**

```bash
opencode mcp add infinmcp --global --url http://<测试机>:8787/mcp \
  --header "Authorization=Bearer <API Key>"
# 加完手动补 "oauth": false（CLI 不会自动加）
```

```jsonc
{
  "mcp": {
    "servers": {           // V2 是 mcp.servers.<名字>；V1 才是 mcp.<名字>
      "infinmcp": {
        "type": "remote",
        "url": "http://<测试机>:8787/mcp",
        "oauth": false,    // 必填：远程默认走 OAuth，我们的服务不支持
        "headers": { "Authorization": "Bearer {env:INFINMCP_API_KEY}" }
      }
    }
  }
}
```

全局配置在 `~/.config/opencode/opencode.json`（`--global` 写的就是它）；不加 `--global` 写当前项目的 `opencode.json`。
`opencode mcp list` 是**按当前目录的项目上下文**报告的，要在实际使用 OpenCode 的目录下执行。

**本地 stdio**（不经 HTTP、不校验 Key，调用者记为 `local`）

```jsonc
{
  "mcpServers": {
    "infinmcp": {
      "command": "node",
      "args": ["/path/to/infinmcp/dist/index.js", "mcp", "-c", "/path/to/infinmcp.config.json"]
    }
  }
}
```

完整的接入说明、环境变量语法差异（`${VAR}` vs `{env:VAR}`）、排错对照表：**[docs/clients.md](docs/clients.md)**。

### 连接配置速查

| 类型 | 字段（必填加 *） |
| --- | --- |
| `mysql` | *`host` · `port`(3306) · *`user` · `password` · `database`(默认库) · `charset`(建议 `utf8mb4`) · 可选标签 `env` / `readonly` / `maxRows` |
| `doris` | *`host` · `port`(9030) · *`user` · `password` · `database`(默认库) · `charset`(建议 `utf8mb4`) · 可选标签 `env` / `readonly` / `maxRows` |
| `redis` | *`host` · `port`(6379) · `username`(ACL) · `password` · `db`(0) · `tls` · 可选标签 `env` / `readonly` / `maxRows` |
| `mongodb` | *`uri`(含账号口令，如 `mongodb://u:p@h:27017/app?authSource=admin`) · `database`(默认库) · 可选标签 `env` / `readonly` / `maxRows` |

连接标签都是**可选元数据**：`env` 只能是 `prod` / `test` / `dev`；`readonly` 表示数据库账号是否只读（`false` = 可能有写权限）；`maxRows` 只能把该连接的行数上限调到全局值以下，实际生效 `min(连接 maxRows, limits.maxRows)`。服务端不会按 `env` 路由，也不会因 `readonly` 放行或拦截任何操作。

```jsonc
"connections": {
  "main":      { "type": "mysql",   "host": "10.0.0.11", "user": "readonly", "password": "{env:MYSQL_PW}", "database": "app", "charset": "utf8mb4", "env": "prod", "readonly": true },
  "warehouse": { "type": "doris",   "host": "10.0.0.14", "port": 9030, "user": "readonly", "password": "{env:DORIS_PW}", "database": "app", "env": "test", "readonly": true, "maxRows": 100 },
  "cache":     { "type": "redis",   "host": "10.0.0.12", "password": "{env:REDIS_PW}", "db": 0, "env": "dev" },
  "docs":      { "type": "mongodb", "uri": "{env:MONGO_URI}", "database": "app", "env": "dev" }
}
```

全局限制：`limits.maxRows`（默认 200，超出标注「已截断」）、`limits.timeoutMs`（默认 10000，同时作连接超时）、
`limits.maxCellWidth`（默认 512，单元格截断长度）、`limits.inlineMaxBytes`（默认 262144）、`limits.inlineMaxRows`（默认 1000，
两者决定 `output: "auto"` 何时落文件）、`limits.exportTtlHours`（默认 24）、`limits.exportMaxFiles`（默认 200）。

字段含义、只读账号怎么建、常见坑：**[docs/connections.md](docs/connections.md)**。

### 连接热更新

`PUT /api/connections/<name>` 会写入 `<data-dir>/connections.json`（权限 `0600`）并立即生效，无需重启。
省略 `password`（MySQL / Redis）或 `uri`（MongoDB）表示「沿用旧值」，前端无需回填密钥。
请求 body 里的 `name` 与路径不同即**重命名**（支持中文，如「测试环境mysql」；新名冲突返回 `409`，
来自配置文件的连接不允许改名）。改名请求需带完整连接字段；仅单进程 `serve` 模式下即时生效。

### AI 管理连接（默认关闭）

除了管理员在 Web 页操作，**MCP 客户端也可以增删改连接**，但默认<u>不允许</u>：

- 开关：`server.allowAiConnectionWrites`（配置文件默认值，`false`）。
  管理员可在 Web「连接」页勾选「允许 AI 管理连接」实时开启 / 关闭，
  该状态写入 `<data-dir>/settings.json`（`0600`）并**热生效**，优先级高于配置文件默认值。
- 开启后，AI 可调用 `create_connection` / `update_connection` / `delete_connection`；
  写入的仍然是同一份 `connections.json`，所以 AI 建的连接与手动添加的**完全一致**，立即出现在 Web 列表里。
- 关闭时这三个工具仍可见（AI 知道有这能力），但调用会返回「管理员未开启」；
  查询工具与 `test_connection` 不受影响。
- `delete_connection` 只能删 `connections.json` 里的连接；来自配置文件的连接需改配置文件重启。

> ⚠️ 安全提醒：开启后服务端会按 AI 给的地址发起连接，存在**内网探测（SSRF）**风险；
> 且口令会出现在 AI 对话记录里。请只在受信任的客户端下开启，并尽量使用只读账号。
> 默认关闭正是为了这个。

## Web 页面

浏览器打开 `http://<host>:<port>/`（静态资源在 `public/`，无构建步骤）。三个 Tab：

- **使用说明**（无需登录即可看）：这是什么、如何拿 API Key、如何把 MCP 客户端接进来（OpenCode / 通用 JSON / 本地 stdio）、17 个工具的用法与调用示例、只读边界、连接管理与常见问题。
- **连接**：连接列表 + 连通性测试；`admin` 可新增 / 编辑 / 删除 / 重命名（支持中文），并可勾选「允许 AI 管理连接」让 MCP 客户端自己增删改（默认关闭）。编辑时口令 / URI 留空即沿用旧值；保存后立即生效。
- **日志**：时间 / 用户 / 工具 / 连接 / 耗时 / 行数 / 状态，支持按用户、工具、连接、状态筛选，SSE 实时刷新（可开关）。

首次访问填入 API Key，之后记在浏览器 `localStorage`，随时可「清除 Key」。

## 运行与部署

直接运行、后台常驻（systemd / pm2）、nginx 反向代理（SSE 注意事项）、监控、加固与排障，见 **[docs/deploy.md](docs/deploy.md)**。

一句话版本：

```bash
npm ci && npm run build
node dist/index.js serve -c infinmcp.config.json -d ~/.config/infinmcp
```

## 配置

配置文件查找顺序：`--config` / `INFINMCP_CONFIG` → `./infinmcp.config.json` → `~/.config/infinmcp/config.json`。
敏感值用 `{env:VAR}` 引用（读取 `.env` 或系统环境变量）；缺失时直接报错。

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "apiKeys": [
      { "name": "chenning", "key": "{env:KEY_CHENNING}", "role": "admin" }
    ],
    "allowAiConnectionWrites": false
  },
  "connections": {
    "main": { "type": "mysql", "host": "10.0.0.11", "user": "readonly", "database": "app" },
    "warehouse": { "type": "doris", "host": "10.0.0.14", "port": 9030, "user": "readonly", "database": "app" },
    "cache": { "type": "redis", "host": "10.0.0.12", "port": 6379, "db": 0 },
    "docs": { "type": "mongodb", "uri": "{env:MONGO_URI}", "database": "app" }
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
  "logs": { "file": "~/.infinmcp/logs.jsonl" }
}
```
