import { createHash, timingSafeEqual } from "node:crypto";
import type { ApiKey } from "./config.js";

export type Role = "admin" | "user";

/** 已鉴权的调用者身份。 */
export interface Principal {
  name: string;
  role: Role;
}

/** 恒定时间字符串比较（先哈希，抹平长度差异）。 */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

type HeaderValue = string | string[] | undefined;

function first(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * 从请求头提取 API Key：
 * - `Authorization: Bearer <key>`
 * - `X-API-Key: <key>`
 * 不接受查询参数传 Key（避免 Key 出现在 URL / 访问日志里）。
 */
export function extractApiKey(headers: {
  authorization?: HeaderValue;
  "x-api-key"?: HeaderValue;
}): string | undefined {
  const authorization = first(headers.authorization);
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  const headerKey = first(headers["x-api-key"]);
  if (headerKey && headerKey.trim() !== "") return headerKey.trim();
  return undefined;
}

/** 按 Key 解析身份；Key 逐个恒定时间比较，命中即返回。 */
export class KeyStore {
  private readonly entries: ApiKey[];

  constructor(entries: ApiKey[]) {
    this.entries = entries;
  }

  get enabled(): boolean {
    return this.entries.length > 0;
  }

  get size(): number {
    return this.entries.length;
  }

  authenticate(apiKey: string | undefined): Principal | null {
    if (!apiKey) return null;
    for (const entry of this.entries) {
      if (safeEqual(entry.key, apiKey)) return { name: entry.name, role: entry.role };
    }
    return null;
  }
}
