# 连接配置指南

本文说明**如何为每个数据库配置连接**：改哪儿、每个字段什么意思、只读账号怎么开、怎么验证。

服务端支持四类连接：`mysql` / `doris` / `redis` / `mongodb`。工具通过**连接名**引用它们（`list_connections` 可查）。

---

## 1. 两种改法，效果不同

| 方式 | 谁能改 | 何时生效 | 存在哪 |
| --- | --- | --- | --- |
| **Web 页面**「连接」页 | `admin` | **立即**（热生效，无需重启） | `<data-dir>/connections.json`（权限 `0600`） |
| **配置文件** `infinmcp.config.json` 的 `connections` | 运维 / 有机器权限的人 | 启动时读取；**改完需重启** | 配置文件本身 |

优先级：**同名连接以 `connections.json` 为准**（加载时会提示一条 warning）。

> 建议：初始化、需要版本管理的连接写进配置文件；临时新增 / 试错用 Web 页面。
>
> 小技巧：只改了配置文件又不想重启时，去 Web 上随便保存一次任意连接，会触发重新加载（服务会重新读配置文件 + `connections.json`）。但**稳妥做法还是重启**。

---

## 2. 公共约定

- **连接名**：在配置文件里是 `connections` 对象的键；Web 表单限制为 `^[A-Za-z0-9_.-]{1,64}$`。建议用 `main` / `cache` / `docs` 这类短名。
- **`type`**：必填，`mysql` / `doris` / `redis` / `mongodb` 四选一。
- 每个连接都会被服务端**强制只读**，与账号权限无关（见第 6 节）。

---

## 3. MySQL / Doris

> **Doris 与 MySQL 协议兼容**：字段定义完全一致，`type` 用 `"doris"`、默认端口是 `9030`（FE 的 MySQL 协议端口，不是 HTTP `8030`）。
> 工具名不同（`doris_query` / `doris_schema` vs `mysql_query` / `mysql_schema`），只读规则与字段含义相同。

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `type` | ✅ | — | `"mysql"` 或 `"doris"` |
| `host` | ✅ | — | 主机名或 IP |
| `port` | | `3306`（Doris `9030`） | |
| `user` | ✅ | — | 建议用只读账号 |
| `password` | | 空 | 建议写 `{env:MYSQL_PW}` / `{env:DORIS_PW}` |
| `database` | | 空 | **默认库**。填了才能用不带库名的表名；`mysql_schema` / `doris_schema` 查表结构时也用它 |
| `charset` | | 驱动默认 | 建议 `utf8mb4`，否则中文/emoji 可能乱码 |

```jsonc
"main": {
  "type": "mysql",
  "host": "10.0.0.11",
  "port": 3306,
  "user": "readonly",
  "password": "{env:MYSQL_PW}",
  "database": "app",
  "charset": "utf8mb4"
}
```

Doris 连接：

```jsonc
"warehouse": {
  "type": "doris",
  "host": "10.0.0.14",
  "port": 9030,
  "user": "readonly",
  "password": "{env:DORIS_PW}",
  "database": "app",
  "charset": "utf8mb4"
}
```

**有意的行为**（避免精度/时区问题，不是 bug）：

- 时间字段以**字符串**返回（`dateStrings: true`），不会因为时区二次转换出错；
- 大整数以**字符串**返回（`bigNumberStrings: true`），避免 JS `Number` 精度丢失（如雪花 ID）。

只读账号需要 `SELECT` + `SHOW VIEW`（`mysql_schema` / `doris_schema` 靠 `information_schema`，本质是 `SELECT`）：

```sql
CREATE USER 'readonly'@'%' IDENTIFIED BY '<pw>';
GRANT SELECT, SHOW VIEW ON app.* TO 'readonly'@'%';
-- 需要看所有库的结构时：GRANT SELECT ON *.* TO 'readonly'@'%';
```

> 注意：`information_schema` 只会显示该账号有权限的对象，这是 MySQL 自身行为。

Doris 的只读账号（RBAC 语法与 MySQL 不同）：

```sql
CREATE USER 'readonly' IDENTIFIED BY '<pw>';
GRANT SELECT_PRIV ON app.* TO 'readonly';
```

> 注意：Doris 的库 / 表 / 列结构同样来自 `information_schema`，因此上面的账号即可支撑 `doris_schema`。

---

## 4. Redis

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `type` | ✅ | — | `"redis"` |
| `host` | ✅ | — | |
| `port` | | `6379` | |
| `username` | | 空 | Redis 6+ ACL 用户名；用 `default` 用户或不启用 ACL 就留空 |
| `password` | | 空 | 建议写 `{env:REDIS_PW}` |
| `db` | | `0` | 逻辑库编号（0–15 常见） |
| `tls` | | `false` | 云 Redis / 要求 TLS 时设为 `true` |

```jsonc
"cache": {
  "type": "redis",
  "host": "10.0.0.12",
  "port": 6379,
  "password": "{env:REDIS_PW}",
  "db": 0
}
```

有口令 + TLS 的云实例：

```jsonc
"cache": {
  "type": "redis",
  "host": "r-xxxx.redis.rds.aliyuncs.com",
  "port": 6379,
  "username": "readonly",
  "password": "{env:REDIS_PW}",
  "db": 0,
  "tls": true
}
```

**注意**：

- 扫描 key 用 `redis_scan`（基于 `SCAN`，不阻塞）；`KEYS` 被明确拒绝。
- `PING` 只用于「测试连通性」，不在工具白名单里，正常查询用不到。
- 连接失败会明确报出目标：`无法连接 Redis (host:port/db): …`。

---

## 5. MongoDB

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `type` | ✅ | `"mongodb"` |
| `uri` | ✅ | 完整连接串，**账号口令写在这里** |
| `database` | | **默认库**。不填的话，每次调用工具都要在参数里给 `database`（`mongo_list_collections` 例外：它会列出所有库） |

```jsonc
"docs": {
  "type": "mongodb",
  "uri": "{env:MONGO_URI}",
  "database": "app"
}
```

`.env`：

```bash
MONGO_URI=mongodb://readonly:change-me@10.0.0.13:27017/app?authSource=admin
```

**注意**：

- 口令里若有 `@ : / ?` 等特殊字符，必须做 URL 编码（例如 `@` → `%40`）。
- 副本集 / Atlas 用 `mongodb+srv://…` 形式。
- `authSource` 常被漏掉：账号建在 `admin` 库时通常需要 `?authSource=admin`。
- URI 在页面和 `config` 命令输出里会**脱敏**成 `mongodb://***@host:27017/app`；因此 Web「编辑」时 **URI 留空 = 沿用原值**（不会把脱敏后的串存回去）。

只读账号：

```js
// mongosh
use admin
db.createUser({
  user: "readonly",
  pwd: "<pw>",
  roles: [{ role: "read", db: "app" }]
})
```

---

## 6. 口令别写明文：`{env:VAR}`

字符串值**整体等于** `{env:VAR}` 时会被替换为环境变量：

```jsonc
{ "password": "{env:MYSQL_PW}" }   // ✅ 会替换
{ "password": "pw-{env:X}" }       // ❌ 不是这种语法，按字面量处理
```

- 缺失的环境变量会**启动即报错**（不会静默使用空口令）——这是刻意设计。
- 用 `.env` 文件（`dotenv` 自动加载）或 `systemd` 的 `EnvironmentFile` 提供变量。
- `connections.json`（Web 保存的）同样支持 `{env:...}`。

---

## 7. 全局限制（所有连接共用）

```jsonc
"limits": {
  "maxRows": 200,      // 单次返回的最大行数/文档数，超出会标注「已截断」
  "timeoutMs": 10000   // 既作查询超时，也作连接超时
}
```

## 8. 验证连接

改完连接后，在 Web「连接」页点该行的 **测试** 按钮（`admin`），会执行一条最小只读指令：

| 类型 | 实际执行 | 成功示例 |
| --- | --- | --- |
| MySQL | `SELECT 1` | `ok: true, detail: "SELECT 1 成功"` |
| Doris | `SELECT 1` | `ok: true, detail: "SELECT 1 成功"` |
| Redis | `PING` | `ok: true, detail: "PING → PONG"` |
| MongoDB | `db.command({ ping: 1 })` | `ok: true, detail: "ping → ok=1"` |

对应接口：`POST /api/connections/<name>/test`（`admin`）。连不上时返回 `{ ok: false, error: "无法连接 MySQL (host:port/db): connect ECONNREFUSED …" }`，**不会**抛 500。

---

## 9. 这几个坑最常见

| 现象 | 原因 / 解决 |
| --- | --- |
| `无法连接 X (…): connect ECONNREFUSED` | 端口/网络不通。先 `telnet host port` 确认 |
| `无法连接 X (…): ER_ACCESS_DENIED_ERROR` | 账号口令或来源 IP 限制 |
| `未指定 database，且连接配置里也没有默认库` | MongoDB 没配 `database`，调用时也没传 → 二选一补上 |
| `mysql_schema` 查表结构报「需要指定 database」 | MySQL 连接没配 `database`，且调用时没传 |
| 结果是 `⌐`/乱码 | MySQL `charset` 建议 `utf8mb4` |
| 结果被截断 | 命中 `limits.maxRows`，缩小查询范围或调高上限 |
| 中文库名/表名查不到 | 用反引号并确认 `charset` |
| Web 编辑后口令丢了 | 口令留空=沿用旧值；要清空口令是**不支持**的，请改配置文件 |

## 10. 再上一道锁（可选但推荐）

服务端已强制只读，数据库账号再收窄一层是双保险：

- MySQL：`GRANT SELECT, SHOW VIEW ON app.* TO 'readonly'@'%';`
- Doris：`GRANT SELECT_PRIV ON app.* TO 'readonly';`
- MongoDB：`roles: [{ role: "read", db: "app" }]`
- Redis（ACL，推荐**拒绝式**，比允许式更不容易漏）：

```
ACL SETUSER infinmcp on ><pw> ~* -@write -@dangerous -@admin -@scripting
```

> Redis 用**允许式**（`+@read`）容易踩坑：我们的白名单里有些命令不属于 `@read`
> （`SCAN` / `DBSIZE` / `INFO` / `TIME` / `EXISTS` / `TYPE` / `TTL` / `PING` 等），
> 用 `+@read` 会导致莫名其妙的 `NOPERM`。用 `-@write -@dangerous` 更稳。

更完整的部署侧加固见 [`deploy.md`](deploy.md#10-数据库侧再加一道锁强烈建议)。
