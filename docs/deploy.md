# 运行与部署

infinmcp 是一个普通 Node 进程，**不需要 Docker**。本文覆盖：直接运行、后台常驻（systemd / pm2）、反向代理、加固与排障。

## 0. 前置条件

- Node.js ≥ 20（开发机用的是 22）
- 能访问目标数据库（MySQL / Doris / Redis / MongoDB）
- 建议在测试环境使用，内网访问

## 1. 安装与构建

```bash
git clone <repo> /opt/infinmcp
cd /opt/infinmcp
npm ci
npm run build          # 产物在 dist/
```

## 2. 配置

```bash
cp infinmcp.config.example.json infinmcp.config.json
cp .env.example .env
chmod 600 .env
```

`.env`：

```bash
# 每人一个 Key（名字要在配置文件的 server.apiKeys 里引用）
KEY_CHENNING=$(openssl rand -hex 32)
KEY_ALICE=$(openssl rand -hex 32)
# 数据库口令 / 连接串
MYSQL_PW=...
DORIS_PW=...
MONGO_URI=mongodb://readonly:...@10.0.0.13:27017/?authSource=admin
```

`infinmcp.config.json` 里用 `{env:VAR}` 引用，缺失时启动即报错（不会静默用空口令）：

```jsonc
{
  "server": {
    "host": "0.0.0.0",
    "port": 8787,
    "apiKeys": [
      { "name": "chenning", "key": "{env:KEY_CHENNING}", "role": "admin" },
      { "name": "alice", "key": "{env:KEY_ALICE}", "role": "user" }
    ]
  },
  "connections": {
    "main": { "type": "mysql", "host": "10.0.0.11", "user": "readonly", "password": "{env:MYSQL_PW}", "database": "app" }
  },
  "limits": { "maxRows": 200, "timeoutMs": 10000 },
  "logs": { "file": "/var/lib/infinmcp/logs.jsonl" }
}
```

> **注意**：`logs.file` 默认是 `~/.infinmcp/logs.jsonl`。如果用 systemd 并开启了 `ProtectHome=true`，务必改成绝对路径（如 `/var/lib/infinmcp/logs.jsonl`）。

校验配置（脱敏输出，可安全贴群）：

```bash
node dist/index.js config -c infinmcp.config.json
```

## 3. 直接运行

| 场景 | 命令 |
| --- | --- |
| 本地调试（stdio，不校验 Key） | `node dist/index.js mcp -c infinmcp.config.json` |
| 多人接入（HTTP + Web） | `node dist/index.js serve -c infinmcp.config.json` |
| 覆盖监听地址 | `... serve -H 127.0.0.1 -p 8799` |

`serve` 至少要有一个 API Key，否则拒绝启动。

临时后台运行：

```bash
nohup node dist/index.js serve -c /opt/infinmcp/infinmcp.config.json -d /var/lib/infinmcp \
  > /var/log/infinmcp.out 2>&1 &
```

### 服务起来之后：把接入方式发给同事

同事需要在**自己的 MCP 客户端**里加一条配置，指向 `http://<服务地址>:8787/mcp`，并带上你发给他的 API Key。
各客户端改哪个文件、用什么命令、常见报错怎么排，见 **[clients.md](clients.md)**（一份可直接转发的文档）。

> 提醒：客户端必须能访问到服务端。绑 `127.0.0.1` 时只有同机客户端可用；跨机要绑 `0.0.0.0`（并配合防火墙 / 反向代理）。

## 4. systemd（推荐）

`/etc/systemd/system/infinmcp.service`：

```ini
[Unit]
Description=infinmcp read-only DB MCP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=infinmcp
Group=infinmcp
WorkingDirectory=/opt/infinmcp
EnvironmentFile=/opt/infinmcp/.env
ExecStart=/usr/bin/node /opt/infinmcp/dist/index.js serve -c /opt/infinmcp/infinmcp.config.json -d /var/lib/infinmcp
Restart=on-failure
RestartSec=3

# 加固
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
ReadWritePaths=/var/lib/infinmcp

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd --system --home /var/lib/infinmcp --shell /usr/sbin/nologin infinmcp
sudo mkdir -p /var/lib/infinmcp && sudo chown infinmcp:infinmcp /var/lib/infinmcp
sudo systemctl daemon-reload
sudo systemctl enable --now infinmcp
sudo systemctl status infinmcp
journalctl -u infinmcp -f          # 看诊断信息（走 stderr）
```

## 5. pm2

```bash
npm i -g pm2
pm2 start /opt/infinmcp/dist/index.js --name infinmcp -- \
  serve -c /opt/infinmcp/infinmcp.config.json -d /var/lib/infinmcp
pm2 save
pm2 startup                        # 按提示执行它输出的那一条命令
```

## 6. 反向代理（可选）

MCP 是流式接口，日志页用的是 SSE，**必须关闭代理缓冲**，否则实时日志会卡住。

```nginx
location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";

    proxy_buffering off;         # SSE / 流式响应必须
    proxy_read_timeout 3600s;    # 长连接
}
```

## 7. 监控与日志

- 存活检查：`GET /healthz` → `{"ok":true,"version":"...","uptimeSeconds":N}`（无需 API Key）
- 调用日志：`logs.jsonl`，每行一条 JSON（含 `user` / `tool` / `connection` / `status` / `durationMs`）
  ```bash
  tail -f /var/lib/infinmcp/logs.jsonl | jq -c '{ts,user,tool,status,durationMs}'
  ```
- 诊断信息（启动摘要、连接测试、配置变更）走 **stderr**，由 journald / pm2 收集
- 进程内还保留最近 1000 条日志，供 Web「日志」页与 SSE 使用

## 8. 多实例注意事项

连接热更新（Web 保存后立即生效）**只在单进程内有效**：

- 建议**单实例**部署（当前定位就是测试环境共用）
- 若必须多副本：把 `-d` 指向共享目录，并约定保存后重启其它副本；或改完配置后统一重启

## 9. 升级 / 回滚

```bash
cd /opt/infinmcp
git fetch --tags && git checkout <tag>
npm ci && npm run build
sudo systemctl restart infinmcp
```

连接配置存在数据目录（`connections.json`，权限 `0600`），升级不覆盖。

## 10. 数据库侧再加一道锁（强烈建议）

服务本身已做只读校验，但数据库账号再收窄一次是「双保险」：

```sql
-- MySQL
CREATE USER 'readonly'@'%' IDENTIFIED BY '<pw>';
GRANT SELECT, SHOW VIEW ON app.* TO 'readonly'@'%';
```

```
# Redis（ACL：推荐拒绝式，比允许式更不容易漏）
ACL SETUSER readonly on ><pw> ~* -@write -@dangerous -@admin -@scripting
```

```js
// MongoDB
use admin
db.createUser({ user: "readonly", pwd: "<pw>", roles: [{ role: "read", db: "app" }] })
```

> 每种库的字段含义、密码写法、常见坑见 [`connections.md`](connections.md)。

## 11. 安全清单

- [ ] 每人一个 Key，用 `openssl rand -hex 32` 生成，不用可预测字符串
- [ ] `.env` 不入库、权限 `600`；配置文件里只写 `{env:...}`
- [ ] `connections.json` 权限 `0600`（程序自动设置）
- [ ] 只在内网 / 测试环境暴露；对外必须走 HTTPS
- [ ] 数据库侧使用只读账号
- [ ] 不要把 Key 放进 URL 查询参数（本服务也不接受这种传法）
- [ ] 定期轮换 Key：改 `.env` 后 `systemctl restart infinmcp`

## 12. 排障

| 现象 | 排查 |
| --- | --- |
| 启动即退出，提示缺环境变量 | `.env` 没加载或变量名拼错；`systemctl` 场景确认 `EnvironmentFile` 路径 |
| 启动提示「serve 模式需要至少配置一个 API Key」 | `server.apiKeys` 为空 |
| `EADDRINUSE` | 端口被占用：`ss -lntp \| grep 8787`，或 `-p` 换端口 |
| 浏览器 401 | Key 错；页面右上角「清除 Key」后重填 |
| 页面 403 | 当前是 `user` 角色，改连接需要 `admin` |
| 「无法连接 MySQL/Doris/Redis/MongoDB」 | 在「连接」页点「测试」看具体报错；`ECONNREFUSED` = 端口/网络不通 |
| 日志页不实时刷新 | 反向代理没关 `proxy_buffering`；或页面「实时」开关被关掉 |
| 结果被截断 | 调高 `limits.maxRows`，或缩小查询范围 |
