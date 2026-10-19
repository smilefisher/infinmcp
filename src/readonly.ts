/**
 * 只读 SQL 守卫。
 *
 * 思路：先把注释与字符串/标识符内容「抹成空格」，再在抹平后的文本上做
 * 首关键字白名单、多语句检测、禁止项检测与顶层 LIMIT 检测，避免字符串常量
 * 或注释里的关键字造成误判。
 */

const ALLOWED_FIRST_KEYWORDS = new Set(["select", "with", "show", "explain", "desc", "describe"]);

/** 这些片段一旦（在非字符串/非注释区域）出现即拒绝。 */
const FORBIDDEN_FRAGMENTS = [
  "into outfile",
  "into dumpfile",
  "into @",
  "for update",
  "for share",
  "lock in share mode",
  "load_file",
];

/** 把注释、字符串、引号标识符的内容替换为空格，保留其余字符。 */
export function maskSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "#") {
      i += 1;
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out += " ";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      out += " ";
      i += 1;
      while (i < n) {
        const c = sql[i]!;
        if (c === "\\" && quote !== "`") {
          i += 2;
          out += "  ";
          continue;
        }
        if (c === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            out += "  ";
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
        out += " ";
      }
      out += " ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** 是否存在「顶层」（括号深度 0）的 LIMIT 关键字。 */
export function hasTopLevelLimit(maskedSql: string): boolean {
  const lower = maskedSql.toLowerCase();
  let depth = 0;
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i]!;
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (lower.startsWith("limit", i)) {
      const before = i === 0 ? " " : lower[i - 1]!;
      const after = lower[i + 5] ?? " ";
      if (!/[a-z0-9_$]/.test(before) && !/[a-z0-9_$]/.test(after)) return true;
    }
  }
  return false;
}

/** 提取括号深度 0 上的所有单词（小写）。 */
export function topLevelWords(maskedSql: string): string[] {
  const lower = maskedSql.toLowerCase();
  const words: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of lower) {
    if (ch === "(") {
      if (current) words.push(current);
      current = "";
      depth += 1;
      continue;
    }
    if (ch === ")") {
      if (current) words.push(current);
      current = "";
      if (depth > 0) depth -= 1;
      continue;
    }
    if (depth !== 0) continue;
    if (/[a-z0-9_$]/.test(ch)) current += ch;
    else if (current) {
      words.push(current);
      current = "";
    }
  }
  if (current) words.push(current);
  return words;
}

export interface ReadOnlySqlResult {
  ok: boolean;
  /** 校验通过时：可执行的 SQL（必要时已追加 LIMIT）。 */
  sql?: string;
  /** 语句类别：select / with / show / explain / desc / describe。 */
  kind?: string;
  /** 是否自动追加了 LIMIT。 */
  limitAppended?: boolean;
  /** 校验失败时的原因。 */
  reason?: string;
}

/**
 * 校验 SQL 是否只读，并在需要时追加 LIMIT。
 * @param effectiveLimit 追加到无顶层 LIMIT 的 SELECT/WITH 上的行数上限。
 */
export function analyzeReadOnlySql(sql: string, effectiveLimit: number): ReadOnlySqlResult {
  const raw = sql.trim();
  if (!raw) return { ok: false, reason: "SQL 为空" };

  const masked = maskSqlLiterals(raw);
  const withoutTrailing = masked.replace(/[\s;]+$/, "");

  if (withoutTrailing.includes(";")) {
    return { ok: false, reason: "禁止执行多条语句（检测到语句分隔符 ;）" };
  }

  const lower = withoutTrailing.toLowerCase();
  const firstMatch = /^[a-z]+/.exec(withoutTrailing.trimStart().toLowerCase());
  if (!firstMatch) return { ok: false, reason: "无法识别 SQL 语句" };
  const first = firstMatch[0]!;

  if (!ALLOWED_FIRST_KEYWORDS.has(first)) {
    return {
      ok: false,
      reason: `只允许只读语句（SELECT/SHOW/EXPLAIN/DESC/DESCRIBE/WITH），检测到 "${first.toUpperCase()}"`,
    };
  }

  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (lower.includes(fragment)) {
      return { ok: false, reason: `禁止使用 "${fragment.toUpperCase()}"` };
    }
  }

  if (first === "explain" && /\banalyze\b/.test(lower)) {
    return { ok: false, reason: "禁止 EXPLAIN ANALYZE（会真正执行被分析的语句）" };
  }

  // WITH 开头的语句在 MySQL 8 也可用于 DELETE / UPDATE，必须确认主语句是 SELECT
  if (first === "with") {
    const words = topLevelWords(withoutTrailing);
    const writeWord = words.find((word) => ["delete", "update", "insert", "replace"].includes(word));
    if (writeWord) {
      return { ok: false, reason: `WITH 语句的写操作不被允许（检测到 "${writeWord.toUpperCase()}"）` };
    }
  }

  const original = raw.replace(/[\s;]+$/, "");
  const appendLimit = (first === "select" || first === "with") && !hasTopLevelLimit(withoutTrailing);
  return {
    ok: true,
    sql: appendLimit ? `${original} LIMIT ${effectiveLimit}` : original,
    kind: first,
    limitAppended: appendLimit,
  };
}

/** 计算实际生效的行数上限：不超过服务端 maxRows。 */
export function effectiveRowLimit(requested: number | undefined, maxRows: number): number {
  if (requested === undefined || requested <= 0) return maxRows;
  return Math.min(requested, maxRows);
}

// ---------------------------------------------------------------------------
// Redis 只读命令白名单
// ---------------------------------------------------------------------------

/** 纯读命令（无子命令歧义）。 */
const REDIS_READ_COMMANDS = new Set<string>([
  // string
  "get", "mget", "getrange", "substr", "strlen",
  // hash
  "hget", "hmget", "hgetall", "hkeys", "hvals", "hlen", "hexists", "hstrlen", "hscan",
  // list
  "lindex", "lrange", "llen", "lpos",
  // set
  "sismember", "smismember", "smembers", "scard", "srandmember", "sdiff", "sinter", "sunion", "sscan",
  // sorted set
  "zscore", "zmscore", "zrange", "zrevrange", "zrangebyscore", "zrevrangebyscore",
  "zrangebylex", "zrevrangebylex", "zrank", "zrevrank", "zcard", "zcount", "zlexcount",
  "zrandmember", "zdiff", "zinter", "zunion", "zintercard", "zscan",
  // bitmap / hll / geo
  "getbit", "bitcount", "bitpos", "pfcount", "geopos", "geodist", "geohash", "geosearch",
  // stream（只读，非阻塞）
  "xlen", "xrange", "xrevrange",
  // generic / server
  "exists", "type", "ttl", "pttl", "dbsize", "scan", "randomkey",
  "info", "time", "lastsave",
]);

/** 需要限制子命令的命令。 */
const REDIS_READ_SUBCOMMANDS: Record<string, string[]> = {
  memory: ["usage", "stats", "doctor"],
  object: ["encoding", "refcount", "idletime", "freq"],
  xinfo: ["stream", "groups", "consumers"],
  pubsub: ["channels", "numsub", "numpat"],
  command: ["count", "info", "docs", "getkeys"],
};

/** 命中这些命令时给出更友好的拒绝原因。 */
const REDIS_DENIED_HINTS: Record<string, string> = {
  keys: "禁止 KEYS（会阻塞服务器），请改用 redis_scan",
};

export interface RedisCommandCheck {
  ok: boolean;
  /** 校验通过时：大写命令名。 */
  command?: string;
  /** 校验通过时：字符串化的参数列表。 */
  args?: string[];
  reason?: string;
}

/** 校验 Redis 命令是否属于只读白名单，并规范化参数。 */
export function checkRedisCommand(commandRaw: unknown, argsRaw: unknown): RedisCommandCheck {
  if (typeof commandRaw !== "string" || commandRaw.trim() === "") {
    return { ok: false, reason: "缺少命令名（command）" };
  }
  const command = commandRaw.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(command)) {
    return { ok: false, reason: `命令名不合法: ${commandRaw}` };
  }

  const rawArgs = argsRaw === undefined || argsRaw === null ? [] : argsRaw;
  if (!Array.isArray(rawArgs)) {
    return { ok: false, reason: "args 必须是数组" };
  }
  const args: string[] = [];
  for (const item of rawArgs) {
    if (typeof item === "string") args.push(item);
    else if (typeof item === "number" || typeof item === "boolean") args.push(String(item));
    else return { ok: false, reason: "args 只支持字符串 / 数字 / 布尔值" };
  }

  const hint = REDIS_DENIED_HINTS[command.toLowerCase()];
  if (hint) return { ok: false, reason: hint };

  const subcommands = REDIS_READ_SUBCOMMANDS[command.toLowerCase()];
  if (subcommands) {
    const sub = (args[0] ?? "").toLowerCase();
    if (!subcommands.includes(sub)) {
      return { ok: false, reason: `${command} 只允许子命令: ${subcommands.join(", ")}` };
    }
    return { ok: true, command, args };
  }

  if (!REDIS_READ_COMMANDS.has(command.toLowerCase())) {
    return { ok: false, reason: `不是允许的只读命令: ${command}（本服务仅暴露只读命令）` };
  }
  return { ok: true, command, args };
}

// ---------------------------------------------------------------------------
// MongoDB 只读校验
// ---------------------------------------------------------------------------

/** 会写入数据的聚合阶段。 */
const MONGO_WRITE_STAGES = new Set(["$out", "$merge"]);
/** 服务端脚本（可被滥用为 DoS / 注入）。 */
const MONGO_SERVER_JS = new Set(["$where", "$function", "$accumulator"]);

export interface MongoCheckResult {
  ok: boolean;
  reason?: string;
}

/** 深度查找第一个命中的键名。 */
function deepFindKey(value: unknown, keys: Set<string>, depth = 0): string | undefined {
  if (depth > 20) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindKey(item, keys, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (keys.has(key)) return key;
      const found = deepFindKey(item, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/** 校验聚合管道：拒绝写入阶段与服务端脚本，任意层级都会检查。 */
export function checkMongoPipeline(pipeline: unknown): MongoCheckResult {
  if (!Array.isArray(pipeline)) return { ok: false, reason: "pipeline 必须是数组" };
  const writeStage = deepFindKey(pipeline, MONGO_WRITE_STAGES);
  if (writeStage) {
    return { ok: false, reason: `禁止聚合写入阶段 ${writeStage}（$out / $merge 会写入数据）` };
  }
  const jsStage = deepFindKey(pipeline, MONGO_SERVER_JS);
  if (jsStage) return { ok: false, reason: `禁止服务端脚本阶段 ${jsStage}` };
  return { ok: true };
}

/** 校验查询条件：拒绝 $where 等。 */
export function checkMongoFilter(filter: unknown): MongoCheckResult {
  if (filter === undefined || filter === null) return { ok: true };
  if (typeof filter !== "object" || Array.isArray(filter)) {
    return { ok: false, reason: "filter 必须是对象" };
  }
  if (deepFindKey(filter, MONGO_SERVER_JS)) {
    return { ok: false, reason: "禁止 $where 等服务端脚本" };
  }
  return { ok: true };
}
