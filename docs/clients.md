# MCP 客户端接入指南

本文说明**如何把 infinmcp 接到各个 MCP 客户端**，重点回答两个问题：**敲什么命令**、**改的是哪个文件**。

已实测版本：Claude Code `2.1.300`、OpenCode `v2.0.29`。

---

## 0. 前提

- **端点**：`http://<服务地址>:8787/mcp`（路径固定，别丢 `/mcp`）
- **API Key**：每人一个，带 `admin` / `user` 角色（见服务端配置的 `server.apiKeys`）
- **网络**：服务默认只监听 `127.0.0.1`，**客户端必须与服务在同一台机器**。跨机要把服务端 `server.host` 改成 `0.0.0.0`，然后客户端用局域网 IP

---

## 1. 一图流：改哪个文件

| 客户端 | 命令 | 写入的文件 | 生效范围 |
| --- | --- | --- | --- |
| **Claude Code** | `claude mcp add … --scope user` | `~/.claude.json` 顶层 `mcpServers` | 所有项目 |
| **Claude Code** | `… --scope local`（默认） | `~/.claude.json` → `projects["<当前目录>"].mcpServers` | 仅该目录 |
| **Claude Code** | `… --scope project` | 项目根目录 `.mcp.json` | 该项目（**可提交**） |
| **OpenCode V2** | `opencode mcp add … --global` | `~/.config/opencode/opencode.json` | 所有项目 |
| **OpenCode V2** | `opencode mcp add …`（不加 `--global`） | 当前项目 `opencode.json` | 该项目 |
| 其它客户端 | 手改配置 | 各自约定的 `mcpServers` 字段 | 以客户端为准 |

> ⚠️ **Claude Code 的 `project` 作用域、OpenCode 的项目级**都会把 **API Key 明文写进项目文件**。
> 如果项目会提交进 git，请改用 `user` / `--global`，或者用环境变量占位（见 §5）。

---

## 2. Claude Code

### 命令

```bash
claude mcp add --transport http infinmcp http://<服务地址>:8787/mcp \
  --header "Authorization: Bearer <你的 API Key>" \
  --scope user
```

三个参数各自的坑：

- **`--transport http`**：必填。它是 HTTP 端点，不是 stdio。
- **`--header "Authorization: Bearer <key>"`**：**这是最常见的失败原因**。漏了之后，Claude Code 拿到 `401` 会误以为服务器要 OAuth，去探 `/register` 做动态客户端注册，最后报出和数据库毫无关系的
  `Dynamic Client Registration rejected (HTTP 404/405)`。看到这个错，**先查 header 有没有配**。
- **`--scope`**：`local`（默认）/ `user` / `project`，含义见上表。

### 写进配置的内容

`~/.claude.json`（`user` 作用域写顶层）：

```jsonc
{
  "mcpServers": {
    "infinmcp": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <你的 API Key>" }
    }
  }
}
```

`local` 作用域则写在同一文件的 `projects["<目录>"].mcpServers` 下。

> `type` **必须写 `"http"`**。只给 `url` 不给 `type`，Claude Code 会把它当成 stdio 服务直接跳过。

### 验证

```bash
claude mcp list          # 期望：infinmcp: http://… - ✔ Connected
claude mcp get infinmcp  # 看详情，异常看 Issue: 行
```

会话里输入 `/mcp` 也能查看状态。

### 生效时机

MCP server 在**会话启动时**加载 —— 加完要**新开一个会话**，老的会话不会热生效。

### 工具名与免确认

Claude Code 会给 MCP 工具加前缀：

```
mcp__infinmcp__mysql_query
mcp__infinmcp__mysql_schema
mcp__infinmcp__doris_query
mcp__infinmcp__doris_schema
mcp__infinmcp__redis_scan
mcp__infinmcp__mongo_find
```

如需免去逐次确认，在项目 `.claude/settings.json` 里按 `mcp__infinmcp`（整个服务）或 `mcp__infinmcp__*`（该服务全部工具）配 permissions。

### 移除 / 换作用域

```bash
claude mcp remove infinmcp --scope user
```

---

## 3. OpenCode V2

### 命令（推荐）

```bash
opencode mcp add infinmcp --global \
  --url http://<服务地址>:8787/mcp \
  --header "Authorization=Bearer <你的 API Key>"
```

> ⚠️ `--header` 的写法两家不同，别记混：
> **OpenCode 是 `"key=value"`（等号）**，Claude Code 是 `"key: value"`（冒号）。

### 加完必须手动补一句 `oauth: false`

CLI **不会**写 `oauth` 字段，而 OpenCode V2 的**远程服务器默认走 OAuth**。
当前能连上只是因为 header 有效、根本不会返回 401；一旦 Key 失效，就会走上和 Claude Code 一样的 OAuth 弯路。

最终应该是：

```jsonc
{
  "mcp": {
    "servers": {                                    // ← V2 的层级
      "infinmcp": {
        "type": "remote",
        "url": "http://127.0.0.1:8787/mcp",
        "oauth": false,                             // ← 手动补
        "headers": { "Authorization": "Bearer <你的 API Key>" }
      }
    }
  }
}
```

### 三个坑

1. **V2 是 `mcp.servers.<名字>`**，V1 才是直接 `mcp.<名字>`。写成 V1 的层级**不报错、静默不生效**。
2. **`oauth: false` 必补**（原因见上）。
3. **`~/.config/opencode/` 下的 `opencode.json` 和 `opencode.jsonc` 都会被加载并合并**，
   顺序是先 `.json` 后 `.jsonc`（即 `.jsonc` 优先级更高）。两个文件都有 `mcp` 键时很容易看混，**建议只在一个文件里写**。

### 验证

```bash
opencode mcp list        # 期望：✓ infinmcp connected
```

或在会话里用 `/mcps` 查看 / 开关。

> ⚠️ `opencode mcp list` 是**按当前目录的项目上下文**报告的：在 `~/.config/opencode` 下执行会显示
> `No MCP servers configured`，要 `cd` 到你实际使用 OpenCode 的目录再执行。

### 移除

OpenCode 没有 `mcp remove` 子命令，删掉配置里对应的那个条目即可。

---

## 4. 其它客户端（通用 JSON）

大多数客户端用 `mcpServers` 这一层：

```jsonc
{
  "mcpServers": {
    "infinmcp": {
      "type": "http",
      "url": "http://<服务地址>:8787/mcp",
      "headers": { "Authorization": "Bearer <你的 API Key>" }
    }
  }
}
```

不同客户端的字段名有差异（有的用 `transport`、有的把 header 叫别的名字），以各自文档为准。
看到 `type` / `url` 这种写法的，照抄即可。

---

## 5. 密钥别写进文件：环境变量占位

把明文 Key 写进配置，等于把 Key 交给了版本库和备份系统。各客户端都支持环境变量替换，语法**不同**：

| 客户端 | 语法 | 例子 |
| --- | --- | --- |
| Claude Code（`.mcp.json`） | `${VAR}` | `"Authorization": "Bearer ${INFINMCP_API_KEY}"` |
| OpenCode V2 | `{env:VAR}` | `"Authorization": "Bearer {env:INFINMCP_API_KEY}"` |
| 运行时配置（服务端） | `{env:VAR}` | `"password": "{env:MYSQL_PW}"` |

注意 Claude Code 是 `${…}`、OpenCode 是 `{env:…}`，**别写反**。Shell 里的 `$VAR` 在 JSON 字符串中**不会**被展开。

---

## 6. 本机 stdio 方式（不适合多人共用）

不走 HTTP、不校验 API Key，调用者记为 `local`：

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

适合本机调试；因为绕过了鉴权与日志归属，**不要**给团队共用。

---

## 7. 排错对照表

| 现象 | 原因 | 解决 |
| --- | --- | --- |
| `Dynamic Client Registration rejected (HTTP 404/405)` | **漏配 `Authorization` header** | 补 `--header`，重新添加 |
| `ENOTFOUND <测试机>` / `<地址>` | 占位符没替换成真实地址 | 换成 IP / 域名 |
| `401 unauthorized` | Key 错、有多余空格、或没带 | 核对 Key（区分大小写） |
| `403 需要 admin 权限` | Key 是 `user` 角色 | 改连接配置需要 `admin`；查询不受影响 |
| 连接超时 / 连不上 | 客户端与服务不在同一台机器 | 服务改绑 `0.0.0.0`，用局域网 IP |
| OpenCode 提示 `needs authentication` | 没写 `oauth: false` | 补上该字段 |
| OpenCode `mcp list` 显示空 | 执行目录不对 | `cd` 到实际使用 OpenCode 的目录 |
| `Failed to connect` 但没有具体错 | 见上面前两条 | 先查 header，再查地址 |

---

## 8. 实测记录

| 客户端 | 版本 | 作用域 | 结果 |
| --- | --- | --- | --- |
| Claude Code | 2.1.300 | `user` | ✔ Connected（两个不同目录都通过） |
| OpenCode | v2.0.29 | `--global` | ✓ connected |

服务端 `oauth_not_supported` 计数为 `0` —— 说明 header 全程生效，未触发任何 OAuth 探测。
