// infinmcp 控制台：连接管理 + 调用日志 + 使用说明。无框架、无构建步骤。
const LS_KEY = "infinmcp.apiKey";

const state = {
  apiKey: localStorage.getItem(LS_KEY) ?? "",
  me: null,
  connections: [],
  tools: [],
  limits: null,
  settings: null,
  version: "",
  logs: [],
  testResults: new Map(),
  tab: "guide",
};

const $ = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const isAdmin = () => state.me?.role === "admin";
const authed = () => Boolean(state.apiKey && state.me);

function fmtTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso ?? "");
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
async function api(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (state.apiKey) headers.Authorization = `Bearer ${state.apiKey}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const error = new Error(json?.message ?? `${res.status} ${res.statusText}`);
    error.status = res.status;
    throw error;
  }
  return json;
}

// ---------------------------------------------------------------------------
// 登录 / 刷新
// ---------------------------------------------------------------------------
function setIdentity() {
  const badge = $("identity");
  if (!authed()) {
    badge.textContent = "未登录";
    badge.className = "badge";
    $("btn-logout").hidden = true;
    return;
  }
  badge.textContent = `${state.me.name} · ${state.me.role}`;
  badge.className = `badge role-${state.me.role}`;
  $("btn-logout").hidden = false;
}

async function bootstrap() {
  if (!state.apiKey) {
    state.me = null;
    setIdentity();
    render();
    return;
  }
  try {
    state.me = await api("/api/me");
  } catch (error) {
    state.me = null;
    if (error.status === 401) {
      state.apiKey = "";
      localStorage.removeItem(LS_KEY);
      if (state.tab === "guide") state.tab = "connections";
      setIdentity();
      render();
      showGate("API Key 无效，请重新输入。");
    } else {
      setIdentity();
      render();
      showGate(`无法连接服务：${error.message}`);
    }
    return;
  }

  try {
    const info = await api("/api/state");
    state.connections = info.connections ?? [];
    state.tools = info.tools ?? [];
    state.limits = info.limits ?? null;
    state.settings = info.settings ?? null;
    state.version = info.version ?? "";
    $("version").textContent = state.version ? `v${state.version}` : "";
  } catch (error) {
    console.warn("加载 /api/state 失败", error);
  }
  await loadLogs();
  setIdentity();
  render();
  syncStream();
}

function setGateVisible(visible) {
  $("gate").hidden = !visible;
}

function showGate(message) {
  setGateVisible(true);
  if (message) {
    $("gate-error").textContent = message;
    $("gate-error").hidden = false;
  }
}

function hideGate() {
  setGateVisible(false);
  $("gate-error").hidden = true;
}

$("key-save").addEventListener("click", saveKey);
$("key-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveKey();
});

async function saveKey() {
  const value = $("key-input").value.trim();
  if (!value) {
    showGate("请输入 API Key。");
    return;
  }
  state.apiKey = value;
  localStorage.setItem(LS_KEY, value);
  $("key-input").value = "";
  await bootstrap();
  if (authed()) setTab(state.tab === "guide" ? "connections" : state.tab);
}

$("btn-logout").addEventListener("click", () => {
  state.apiKey = "";
  state.me = null;
  state.logs = [];
  localStorage.removeItem(LS_KEY);
  stopStream();
  setIdentity();
  render();
  showGate("已清除本机保存的 API Key。");
});

$("btn-refresh").addEventListener("click", () => void bootstrap());

// ---------------------------------------------------------------------------
// Tab 切换
// ---------------------------------------------------------------------------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  render();
}

function render() {
  const guideTab = state.tab === "guide";
  const loggedIn = authed();
  $("panel-guide").hidden = !guideTab;
  $("panel-connections").hidden = !(loggedIn && state.tab === "connections");
  $("panel-logs").hidden = !(loggedIn && state.tab === "logs");

  if (guideTab || loggedIn) hideGate();
  else setGateVisible(true);

  if (loggedIn && state.tab === "connections") renderConnections();
  if (loggedIn && state.tab === "logs") renderLogs();
}

// ---------------------------------------------------------------------------
// 使用说明：代码块复制
// ---------------------------------------------------------------------------
document.addEventListener("click", (event) => {
  const button = event.target.closest(".copy");
  if (!button) return;
  const pre = button.parentElement.querySelector("pre");
  const text = pre ? pre.innerText : "";
  navigator.clipboard
    ?.writeText(text)
    .then(() => {
      button.textContent = "已复制";
      setTimeout(() => (button.textContent = "复制"), 1500);
    })
    .catch(() => {
      button.textContent = "复制失败";
      setTimeout(() => (button.textContent = "复制"), 1500);
    });
});

// ---------------------------------------------------------------------------
// 连接
// ---------------------------------------------------------------------------
function renderConnections() {
  $("limits").textContent = state.limits
    ? `行数上限 maxRows=${state.limits.maxRows}，单元格 maxCellWidth=${state.limits.maxCellWidth}，` +
      `超时 timeoutMs=${state.limits.timeoutMs}ms，导出保留 ${state.limits.exportTtlHours}h / 最多 ${state.limits.exportMaxFiles} 个`
    : "";
  const canEdit = isAdmin();
  $("btn-new-conn").hidden = !canEdit;
  $("conn-readonly").hidden = canEdit;

  // AI 管理连接开关：仅 admin 可见 / 可操作
  const aiBox = $("ai-write-box");
  if (aiBox) {
    aiBox.hidden = !canEdit;
    $("ai-write-hint").hidden = !canEdit;
    if (canEdit && state.settings) {
      const enabled = Boolean(state.settings.allowAiConnectionWrites);
      $("ai-write-toggle").checked = enabled;
      $("ai-write-state").textContent = enabled ? "已开启" : "已关闭（默认）";
    }
  }

  const list = $("conn-list");
  if (state.connections.length === 0) {
    list.innerHTML = '<div class="empty">还没有配置任何连接。</div>';
    return;
  }

  const rows = state.connections
    .map((conn) => {
      const target =
        conn.type === "mongodb"
          ? `${esc(conn.uri ?? "")}${conn.database ? ` （默认库 ${esc(conn.database)}）` : ""}`
          : `${esc(conn.host ?? "")}:${esc(conn.port ?? "")}${
              (conn.type === "mysql" || conn.type === "doris") && conn.database ? ` / ${esc(conn.database)}` : ""
            }${conn.type === "redis" && conn.db !== undefined ? ` （db=${esc(conn.db)}）` : ""}`;
      const user = conn.user ? `<div class="sub">用户 ${esc(conn.user)}</div>` : "";
      const secret = conn.hasPassword ? '<span class="pill">已设口令</span>' : '<span class="muted small">无口令</span>';
      const result = state.testResults.get(conn.name);
      const testCell = result
        ? result.ok
          ? `<span class="pill ok">可用 ${result.latencyMs}ms</span>`
          : `<span class="pill err" title="${esc(result.error)}">失败</span>`
        : "";
      const actions = canEdit
        ? `<div class="row">
             <button type="button" data-action="test" data-name="${esc(conn.name)}">测试</button>
             <button type="button" data-action="edit" data-name="${esc(conn.name)}">编辑</button>
             <button type="button" class="danger" data-action="delete" data-name="${esc(conn.name)}">删除</button>
           </div>`
        : "";
      const tags = [];
      if (conn.env) {
        tags.push(`<span class="pill ${conn.env === "prod" ? "err" : "ok"}">${esc(conn.env)}</span>`);
      }
      if (conn.readonly !== undefined) {
        tags.push(
          conn.readonly
            ? '<span class="pill ok">只读</span>'
            : '<span class="pill err">可能可写</span>',
        );
      }
      if (conn.maxRowsOverride !== undefined) {
        tags.push(`<span class="pill">≤${esc(conn.maxRowsOverride)} 行</span>`);
      }
      const tagsCell = tags.length > 0 ? tags.join(" ") : '<span class="muted small">—</span>';
      return `<tr>
        <td class="mono nowrap">${esc(conn.name)}</td>
        <td class="nowrap"><span class="pill">${esc(conn.type)}</span></td>
        <td class="nowrap">${tagsCell}</td>
        <td>${target}${user}</td>
        <td class="nowrap">${secret}</td>
        <td class="nowrap">${testCell}</td>
        <td>${actions}</td>
      </tr>`;
    })
    .join("");

  list.innerHTML = `<table>
    <thead><tr><th>名称</th><th>类型</th><th>标签</th><th>地址</th><th>口令</th><th>连通性</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

$("conn-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const name = button.dataset.name;
  const action = button.dataset.action;
  if (action === "edit") openEdit(name);
  if (action === "delete") await removeConnection(name);
  if (action === "test") await testConnection(name);
});

// AI 管理连接开关（admin）
const aiToggle = $("ai-write-toggle");
if (aiToggle) {
  aiToggle.addEventListener("change", async () => {
    const wanted = aiToggle.checked;
    aiToggle.disabled = true;
    try {
      const res = await api("/api/settings", { method: "PUT", body: { allowAiConnectionWrites: wanted } });
      state.settings = res.settings ?? { allowAiConnectionWrites: wanted };
    } catch (error) {
      window.alert(`保存「允许 AI 管理连接」失败：${error.message}`);
      aiToggle.checked = !wanted;
    } finally {
      aiToggle.disabled = false;
      renderConnections();
    }
  });
}

async function testConnection(name) {
  const button = document.querySelector(`button[data-action="test"][data-name="${CSS.escape(name)}"]`);
  if (button) {
    button.disabled = true;
    button.textContent = "测试中…";
  }
  try {
    const result = await api(`/api/connections/${encodeURIComponent(name)}/test`, { method: "POST" });
    state.testResults.set(name, result);
  } catch (error) {
    state.testResults.set(name, { ok: false, latencyMs: 0, error: error.message });
  } finally {
    renderConnections();
  }
}

async function removeConnection(name) {
  if (!window.confirm(`确定删除连接 "${name}" 吗？此操作立即生效。`)) return;
  try {
    await api(`/api/connections/${encodeURIComponent(name)}`, { method: "DELETE" });
    state.testResults.delete(name);
    await bootstrap();
  } catch (error) {
    window.alert(`删除失败：${error.message}`);
  }
}

// ---- 弹窗表单 ----
const dialog = $("conn-dialog");
const form = $("conn-form");

function currentGroup() {
  return form.querySelector(`[data-group="${$("cf-type").value}"]`);
}

function syncGroups() {
  form.querySelectorAll("[data-group]").forEach((el) => {
    el.hidden = el.dataset.group !== $("cf-type").value;
  });
}

function setKeepHintVisible(visible) {
  form.querySelectorAll('[data-hint="keep"]').forEach((el) => (el.hidden = !visible));
}

$("cf-type").addEventListener("change", syncGroups);
$("btn-new-conn").addEventListener("click", () => openCreate());
$("conn-cancel").addEventListener("click", () => dialog.close());

function resetForm() {
  form.reset();
  $("conn-error").hidden = true;
  syncGroups();
}

function openCreate() {
  resetForm();
  $("conn-dialog-title").textContent = "新增连接";
  $("cf-name").disabled = false;
  $("cf-name-note").hidden = true;
  $("cf-type").disabled = false;
  setKeepHintVisible(false);
  dialog.dataset.mode = "create";
  dialog.dataset.name = "";
  dialog.showModal();
}

function openEdit(name) {
  const conn = state.connections.find((item) => item.name === name);
  if (!conn) return;
  resetForm();
  $("conn-dialog-title").textContent = `编辑连接 ${name}`;
  $("cf-name").value = name;
  // 仅存在于配置文件的连接不能在这里改名（否则旧名会在重启后复活）。
  $("cf-name").disabled = Boolean(conn.static);
  const nameNote = $("cf-name-note");
  nameNote.hidden = !conn.static;
  nameNote.textContent = conn.static ? "该连接来自配置文件，不能在这里改名；请修改配置文件后重启服务。" : "";
  $("cf-env").value = conn.env ?? "";
  $("cf-readonly").value = conn.readonly === undefined ? "" : String(conn.readonly);
  $("cf-maxrows").value = conn.maxRowsOverride ?? "";
  $("cf-type").value = conn.type;
  $("cf-type").disabled = true;
  setKeepHintVisible(true);
  syncGroups();

  if (conn.type === "mysql") {
    $("cf-mysql-host").value = conn.host ?? "";
    $("cf-mysql-port").value = conn.port ?? "";
    $("cf-mysql-user").value = conn.user ?? "";
    $("cf-mysql-db").value = conn.database ?? "";
  } else if (conn.type === "doris") {
    $("cf-doris-host").value = conn.host ?? "";
    $("cf-doris-port").value = conn.port ?? "";
    $("cf-doris-user").value = conn.user ?? "";
    $("cf-doris-db").value = conn.database ?? "";
  } else if (conn.type === "redis") {
    $("cf-redis-host").value = conn.host ?? "";
    $("cf-redis-port").value = conn.port ?? "";
    $("cf-redis-username").value = conn.user ?? "";
    $("cf-redis-db").value = conn.db ?? "";
  } else {
    const hint = form.querySelector('[data-group="mongodb"] [data-hint="keep"]');
    if (hint) hint.textContent = `当前 URI：${conn.uri ?? ""} — 留空表示沿用`;
    $("cf-mongo-db").value = conn.database ?? "";
  }

  dialog.dataset.mode = "edit";
  dialog.dataset.name = name;
  dialog.showModal();
}

function numOrUndefined(value) {
  const text = String(value ?? "").trim();
  if (text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function strOrUndefined(value) {
  const text = String(value ?? "").trim();
  return text === "" ? undefined : text;
}

function buildPayload() {
  const type = $("cf-type").value;
  const env = $("cf-env").value;
  const readonly = $("cf-readonly").value;
  const maxRows = numOrUndefined($("cf-maxrows").value);
  const meta = {
    ...(env ? { env } : {}),
    ...(readonly === "" ? {} : { readonly: readonly === "true" }),
    ...(maxRows === undefined ? {} : { maxRows }),
  };
  if (type === "mysql") {
    return {
      type,
      ...meta,
      host: strOrUndefined($("cf-mysql-host").value),
      port: numOrUndefined($("cf-mysql-port").value),
      user: strOrUndefined($("cf-mysql-user").value),
      password: strOrUndefined($("cf-mysql-password").value),
      database: strOrUndefined($("cf-mysql-db").value),
      charset: strOrUndefined($("cf-mysql-charset").value),
    };
  }
  if (type === "doris") {
    return {
      type,
      ...meta,
      host: strOrUndefined($("cf-doris-host").value),
      port: numOrUndefined($("cf-doris-port").value),
      user: strOrUndefined($("cf-doris-user").value),
      password: strOrUndefined($("cf-doris-password").value),
      database: strOrUndefined($("cf-doris-db").value),
      charset: strOrUndefined($("cf-doris-charset").value),
    };
  }
  if (type === "redis") {
    const tls = $("cf-redis-tls").value;
    return {
      type,
      ...meta,
      host: strOrUndefined($("cf-redis-host").value),
      port: numOrUndefined($("cf-redis-port").value),
      username: strOrUndefined($("cf-redis-username").value),
      password: strOrUndefined($("cf-redis-password").value),
      db: numOrUndefined($("cf-redis-db").value),
      ...(tls === "" ? {} : { tls: tls === "true" }),
    };
  }
  return {
    type,
    ...meta,
    uri: strOrUndefined($("cf-mongo-uri").value),
    database: strOrUndefined($("cf-mongo-db").value),
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const originalName = dialog.dataset.mode === "edit" ? dialog.dataset.name : "";
  const name = $("cf-name").value.trim();
  const errorBox = $("conn-error");
  errorBox.hidden = true;

  if (!name) {
    errorBox.textContent = "请填写连接名。";
    errorBox.hidden = false;
    return;
  }

  const payload = buildPayload();
  payload.name = name;
  for (const key of Object.keys(payload)) {
    if (payload[key] === undefined) delete payload[key];
  }

  try {
    // 编辑时 URL 用旧名，body.name 带新名：服务端据此判断是否重命名。
    const urlName = originalName || name;
    await api(`/api/connections/${encodeURIComponent(urlName)}`, { method: "PUT", body: payload });
    dialog.close();
    await bootstrap();
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------
function renderLogs() {
  const toolSelect = $("f-tool");
  const currentTool = toolSelect.value;
  toolSelect.innerHTML =
    '<option value="">全部工具</option>' +
    state.tools.map((tool) => `<option value="${esc(tool.name)}">${esc(tool.name)}</option>`).join("");
  toolSelect.value = currentTool;

  const connSelect = $("f-conn");
  const currentConn = connSelect.value;
  connSelect.innerHTML =
    '<option value="">全部连接</option>' +
    state.connections.map((conn) => `<option value="${esc(conn.name)}">${esc(conn.name)}</option>`).join("");
  connSelect.value = currentConn;

  const user = $("f-user").value.trim().toLowerCase();
  const tool = $("f-tool").value;
  const conn = $("f-conn").value;
  const status = $("f-status").value;

  const filtered = state.logs.filter((entry) => {
    if (user && !String(entry.user ?? "").toLowerCase().includes(user)) return false;
    if (tool && entry.tool !== tool) return false;
    if (conn && entry.connection !== conn) return false;
    if (status && entry.status !== status) return false;
    return true;
  });

  const list = $("log-list");
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">${state.logs.length === 0 ? "暂无日志。" : "没有符合筛选条件的日志。"}</div>`;
    return;
  }

  const rows = filtered
    .slice(-400)
    .reverse()
    .map((entry) => {
      const detail = entry.status === "error" ? entry.error ?? "" : entry.summary ?? "";
      return `<tr>
        <td class="nowrap muted">${esc(fmtTime(entry.ts))}</td>
        <td class="nowrap">${esc(entry.user ?? "")}</td>
        <td class="nowrap mono">${esc(entry.tool ?? "")}</td>
        <td class="nowrap">${esc(entry.connection ?? "—")}</td>
        <td class="nowrap">${esc(entry.durationMs ?? 0)}ms</td>
        <td class="nowrap">${entry.rowCount === undefined ? "—" : esc(entry.rowCount)}</td>
        <td class="nowrap"><span class="pill ${entry.status === "ok" ? "ok" : "err"}">${entry.status === "ok" ? "成功" : "失败"}</span></td>
        <td>${esc(detail)}</td>
      </tr>`;
    })
    .join("");

  list.innerHTML = `<table>
    <thead><tr><th>时间</th><th>用户</th><th>工具</th><th>连接</th><th>耗时</th><th>行数</th><th>状态</th><th>摘要</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

["f-user", "f-tool", "f-conn", "f-status"].forEach((id) => {
  $(id).addEventListener("input", renderLogs);
});

$("btn-clear-logs").addEventListener("click", () => {
  state.logs = [];
  renderLogs();
});

$("live").addEventListener("change", syncStream);

async function loadLogs() {
  try {
    const data = await api("/api/logs?limit=300");
    state.logs = data.entries ?? [];
  } catch (error) {
    console.warn("加载日志失败", error);
  }
}

// ---- SSE 实时流（用 fetch 以携带 Authorization 头；EventSource 不支持自定义头）----
let streamController = null;

function stopStream() {
  streamController?.abort();
  streamController = null;
  $("stream-state").textContent = "";
}

function syncStream() {
  const wanted = $("live").checked && authed();
  if (!wanted) {
    stopStream();
    return;
  }
  if (streamController) return;
  void openStream();
}

async function openStream() {
  streamController = new AbortController();
  $("stream-state").textContent = "连接中…";
  try {
    const res = await fetch("/api/logs/stream", {
      headers: { Authorization: `Bearer ${state.apiKey}` },
      signal: streamController.signal,
    });
    if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
    $("stream-state").textContent = "实时";

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          try {
            const entry = JSON.parse(line.slice(6));
            state.logs.push(entry);
            if (state.logs.length > 2000) state.logs.splice(0, state.logs.length - 2000);
            if (state.tab === "logs") renderLogs();
          } catch {
            /* 忽略脏帧 */
          }
        }
      }
    }
    $("stream-state").textContent = "";
  } catch (error) {
    if (error.name === "AbortError") return;
    $("stream-state").textContent = "已断开";
  } finally {
    streamController = null;
  }
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
setIdentity();
if (state.apiKey) {
  void bootstrap();
} else {
  state.tab = "guide";
  render();
}
