#!/usr/bin/env bash
# infinmcp 启动脚本（后台常驻，pid / 日志都放在数据目录）
#
# 用法：
#   ./startup.sh            # 启动（等价于 start）
#   ./startup.sh start
#   ./startup.sh stop
#   ./startup.sh restart
#   ./startup.sh status
#
# 可用环境变量覆盖：
#   INFINMCP_CONFIG     配置文件路径（默认自动找 infinmcp.config.json，其次 local-test.config.json）
#   INFINMCP_DATA_DIR   数据目录（connections.json / 日志 / pid，默认见下方）
#   INFINMCP_HOST       监听地址（覆盖配置）
#   INFINMCP_PORT       监听端口（覆盖配置）
#   INFINMCP_LOG_FILE   控制台输出日志（默认 <数据目录>/serve.out）
#   INFINMCP_PID_FILE   pid 文件（默认 <数据目录>/serve.pid）
#   INFINMCP_SKIP_BUILD=1  不自动编译
#
# 示例：
#   INFINMCP_PORT=8799 ./startup.sh start
#   INFINMCP_CONFIG=./infinmcp.config.json ./startup.sh restart

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$ROOT/dist/index.js"

log()  { printf '%s\n' "$*"; }
die()  { printf '错误: %s\n' "$*" >&2; exit 1; }

# ---------- 配置定位 ----------
if [[ -n "${INFINMCP_CONFIG:-}" ]]; then
  CONFIG="$INFINMCP_CONFIG"
elif [[ -f "$ROOT/infinmcp.config.json" ]]; then
  CONFIG="$ROOT/infinmcp.config.json"
elif [[ -f "$ROOT/local-test.config.json" ]]; then
  CONFIG="$ROOT/local-test.config.json"
else
  die "找不到配置文件。请先 \`cp infinmcp.config.example.json infinmcp.config.json\`（或指定 INFINMCP_CONFIG）。"
fi
[[ -f "$CONFIG" ]] || die "配置文件不存在：$CONFIG"

# 数据目录默认跟着配置走，避免 connections.json 跑到别的目录「看起来丢了」
if [[ -n "${INFINMCP_DATA_DIR:-}" ]]; then
  DATA_DIR="$INFINMCP_DATA_DIR"
elif [[ "$(basename "$CONFIG")" == local-test.config.json ]]; then
  DATA_DIR="$HOME/.config/infinmcp-local"
else
  DATA_DIR="$HOME/.config/infinmcp"
fi

PID_FILE="${INFINMCP_PID_FILE:-$DATA_DIR/serve.pid}"
LOG_FILE="${INFINMCP_LOG_FILE:-$DATA_DIR/serve.out}"
DEFAULT_HEALTH_URL="http://127.0.0.1:${INFINMCP_PORT:-8787}/healthz"

mkdir -p "$DATA_DIR"

# ---------- 工具函数 ----------
running_pid() {
  [[ -s "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

# 从启动日志里抓健康检查地址（配置里的端口不一定等于 8787）
health_url() {
  local url
  url="$(grep -oE 'http://[^ ]+/healthz' "$LOG_FILE" 2>/dev/null | tail -n 1 || true)"
  printf '%s' "${url:-$DEFAULT_HEALTH_URL}"
}

is_healthy() {
  curl -fsS -m 2 "$(health_url)" >/dev/null 2>&1
}

ensure_build() {
  [[ "${INFINMCP_SKIP_BUILD:-0}" == "1" ]] && return 0

  local need=0 newer=""
  [[ -f "$ENTRY" ]] || need=1
  if [[ "$need" == "0" ]]; then
    newer="$(find "$ROOT/src" -type f -newer "$ENTRY" -print -quit 2>/dev/null || true)"
    [[ -n "$newer" ]] && need=1
  fi
  [[ "$need" == "0" && ( "$ROOT/package.json" -nt "$ENTRY" || "$ROOT/tsconfig.json" -nt "$ENTRY" ) ]] && need=1

  if [[ "$need" == "1" ]]; then
    log "检测到 dist/ 缺失或源码比产物新，先编译…"
    ( cd "$ROOT" && npm run build >/dev/null )
    log "编译完成。"
  fi
}

# ---------- 子命令 ----------
cmd_status() {
  local pid url base
  if pid="$(running_pid)"; then
    url="$(health_url)"
    base="${url%/healthz}"
    log "状态: 运行中 (pid $pid)"
    log "配置: $CONFIG"
    log "数据目录: $DATA_DIR"
    log "健康检查: $url $(is_healthy && echo '→ OK' || echo '→ 无响应')"
    log "Web 页面: $base/"
    log "MCP 端点: POST $base/mcp"
    log "输出日志: $LOG_FILE"
  else
    log "状态: 未运行"
    log "配置: $CONFIG"
    log "数据目录: $DATA_DIR"
    log "输出日志: $LOG_FILE"
    return 3
  fi
}

cmd_start() {
  local pid
  if pid="$(running_pid)"; then
    log "服务已在运行 (pid $pid)，无需重复启动。"
    cmd_status
    return 0
  fi
  # 清理上次残留的 pid 文件
  [[ -f "$PID_FILE" ]] && rm -f "$PID_FILE"

  ensure_build

  local args=(serve -c "$CONFIG" -d "$DATA_DIR")
  [[ -n "${INFINMCP_HOST:-}" ]] && args+=(-H "$INFINMCP_HOST")
  [[ -n "${INFINMCP_PORT:-}" ]] && args+=(-p "$INFINMCP_PORT")

  local offset=0
  [[ -f "$LOG_FILE" ]] && offset="$(stat -c %s "$LOG_FILE" 2>/dev/null || echo 0)"
  {
    printf '\n===== %s 启动 %s =====\n' "$(date '+%F %T')" "$args[*]"
  } >>"$LOG_FILE"

  cd "$ROOT"
  nohup node "$ENTRY" "${args[@]}" >>"$LOG_FILE" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"

  log "已拉起进程 pid=$pid，等待健康检查…"
  local i url
  for i in $(seq 1 40); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      printf '启动失败，进程已退出。日志末尾：\n' >&2
      tail -c +$((offset + 1)) "$LOG_FILE" 2>/dev/null | tail -n 20 >&2 || true
      exit 1
    fi
    url="$(tail -c +$((offset + 1)) "$LOG_FILE" 2>/dev/null | grep -oE 'http://[^ ]+/healthz' | tail -n 1 || true)"
    if [[ -n "$url" ]] && curl -fsS -m 2 "$url" >/dev/null 2>&1; then
      log "启动成功。"
      cmd_status
      return 0
    fi
    sleep 0.5
  done

  printf '启动超时（20s 内健康检查未通过）。日志末尾：\n' >&2
  tail -c +$((offset + 1)) "$LOG_FILE" 2>/dev/null | tail -n 20 >&2 || true
  exit 1
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    log "服务未运行。"
    rm -f "$PID_FILE"
    return 0
  fi
  log "正在停止 pid=$pid …"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 30); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    log "优雅退出超时，强制结束。"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  log "已停止。"
}

cmd_restart() {
  cmd_stop
  cmd_start
}

# ---------- 入口 ----------
case "${1:-start}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  -h|--help|help)
    sed -n '2,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
  *) die "未知命令：$1（可用：start / stop / restart / status）" ;;
esac
