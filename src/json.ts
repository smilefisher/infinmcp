/** BSON 值（ObjectId / Long / Decimal128 / Binary 等）统一转成可读字符串。 */
function isBsonLike(value: object): value is { _bsontype: string } & Record<string, unknown> {
  return typeof (value as { _bsontype?: unknown })._bsontype === "string";
}

function bsonToJson(value: Record<string, unknown> & { _bsontype: string }): unknown {
  const bsonType = value._bsontype;
  try {
    switch (bsonType) {
      case "ObjectId":
        return typeof value.toHexString === "function" ? (value.toHexString as () => string)() : String(value);
      case "Binary": {
        const buffer = value.buffer;
        if (buffer instanceof Uint8Array) return `0x${Buffer.from(buffer).toString("hex")}`;
        return "0x";
      }
      default:
        return typeof value.toString === "function" ? String(value) : null;
    }
  } catch {
    return null;
  }
}

/** 把驱动返回值转换成 JSON 安全的值（Buffer / Date / bigint / BSON 归一化）。 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString("hex")}`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === "object") {
    if (isBsonLike(value)) return bsonToJson(value as Record<string, unknown> & { _bsontype: string });
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(item);
    }
    return out;
  }
  return value;
}

/** 把一行记录转换成 JSON 安全的对象。 */
export function rowToJsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = toJsonSafe(value);
  return out;
}
