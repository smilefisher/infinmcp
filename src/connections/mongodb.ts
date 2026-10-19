import { MongoClient, ObjectId, type Document } from "mongodb";
import { redactMongoUri, type MongoConnectionConfig } from "../config.js";
import { toJsonSafe } from "../json.js";

export interface MongoQueryResult {
  documents: unknown[];
  rowCount: number;
  truncated: boolean;
}

export interface MongoListResult {
  mode: "collections" | "databases";
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
}

export interface MongoSchemaRow {
  field: string;
  types: string[];
  present: number;
}

export interface MongoSchemaResult {
  collection: string;
  sampleSize: number;
  rows: MongoSchemaRow[];
  rowCount: number;
}

const labels = new WeakMap<MongoClient, string>();

/** 创建 MongoDB 客户端（懒连接；用 serverSelectionTimeoutMS 控制不可达时的失败速度）。 */
export function createMongoClient(config: MongoConnectionConfig, timeoutMs: number): MongoClient {
  const client = new MongoClient(config.uri, {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    maxPoolSize: 4,
    appName: "infinmcp",
  });
  labels.set(client, redactMongoUri(config.uri));
  return client;
}

/** 支持扩展 JSON 的 {$oid} / {$date}（模型传入的 JSON 里常见）。 */
function reviveExtendedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveExtendedJson);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && typeof obj.$oid === "string") {
      try {
        return new ObjectId(obj.$oid);
      } catch {
        return obj;
      }
    }
    if (keys.length === 1 && typeof obj.$date === "string") return new Date(obj.$date);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(obj)) out[key] = reviveExtendedJson(item);
    return out;
  }
  return value;
}

/** 判断是否为「连不上 / 拓扑不可用」类错误（可给出更清晰的提示）。 */
function isConnectionError(error: Error): boolean {
  const name = error.name ?? "";
  return (
    name.includes("ServerSelection") ||
    name.includes("MongoNetwork") ||
    name.includes("MongoTopology") ||
    name.includes("MongoNotConnected") ||
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed out|Topology is closed|not connected/i.test(error.message)
  );
}

function mongoLabel(client: MongoClient): string {
  return labels.get(client) ?? "unknown";
}

/**
 * 每次操作前显式连接。
 * 这样即便上一次连接失败把拓扑置为 closed，这里也会重新尝试，而不是报出难懂的 "Topology is closed"。
 */
async function ensureConnected(client: MongoClient): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    const err = error as Error;
    if (isConnectionError(err)) {
      throw new Error(`无法连接 MongoDB (${mongoLabel(client)}): ${err.message}`);
    }
    throw error;
  }
}

async function withMongoErrors<T>(client: MongoClient, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const err = error as Error;
    if (err.message.startsWith("无法连接 MongoDB")) throw err;
    if (isConnectionError(err)) {
      throw new Error(`无法连接 MongoDB (${mongoLabel(client)}): ${err.message}`);
    }
    throw error;
  }
}

function sliceDocuments(docs: Document[], maxRows: number): MongoQueryResult {
  const truncated = docs.length > maxRows;
  const limited = (truncated ? docs.slice(0, maxRows) : docs).map(toJsonSafe);
  return { documents: limited, rowCount: limited.length, truncated };
}

export interface MongoFindOptions {
  database: string;
  collection: string;
  filter?: unknown;
  projection?: unknown;
  sort?: unknown;
  limit: number;
  skip?: number;
  maxRows: number;
  timeoutMs: number;
}

export async function mongoFind(client: MongoClient, opts: MongoFindOptions): Promise<MongoQueryResult> {
  await ensureConnected(client);
  return withMongoErrors(client, async () => {
    const docs = await client
      .db(opts.database)
      .collection(opts.collection)
      .find(reviveExtendedJson(opts.filter ?? {}) as Document, {
        projection: opts.projection as Document | undefined,
        sort: opts.sort as Document | undefined,
        skip: opts.skip,
        limit: opts.limit,
        maxTimeMS: opts.timeoutMs,
      })
      .toArray();
    return sliceDocuments(docs, opts.maxRows);
  });
}

export interface MongoAggregateOptions {
  database: string;
  collection: string;
  pipeline: unknown[];
  maxRows: number;
  timeoutMs: number;
}

export async function mongoAggregate(
  client: MongoClient,
  opts: MongoAggregateOptions,
): Promise<MongoQueryResult> {
  await ensureConnected(client);
  return withMongoErrors(client, async () => {
    const pipeline: Document[] = [
      ...opts.pipeline.map((stage) => reviveExtendedJson(stage) as Document),
      { $limit: opts.maxRows + 1 },
    ];
    const docs = await client
      .db(opts.database)
      .collection(opts.collection)
      .aggregate(pipeline, { maxTimeMS: opts.timeoutMs })
      .toArray();
    return sliceDocuments(docs, opts.maxRows);
  });
}

export interface MongoListOptions {
  database?: string;
  maxRows: number;
  timeoutMs: number;
}

export async function mongoListCollections(
  client: MongoClient,
  opts: MongoListOptions,
): Promise<MongoListResult> {
  await ensureConnected(client);
  return withMongoErrors(client, async () => {
    if (opts.database) {
      const collections = await client
        .db(opts.database)
        .listCollections({}, { nameOnly: false })
        .toArray();
      const rows = collections.map((info) => ({
        name: info.name,
        type: info.type,
        ...(info.options?.validator ? { hasValidator: true } : {}),
        ...(info.options?.capped ? { capped: true } : {}),
      }));
      const truncated = rows.length > opts.maxRows;
      const limited = truncated ? rows.slice(0, opts.maxRows) : rows;
      return { mode: "collections" as const, rows: limited, rowCount: limited.length, truncated };
    }

    const result = await client.db("admin").admin().listDatabases();
    const rows = result.databases.map((db) => ({
      name: db.name,
      sizeOnDisk: db.sizeOnDisk,
      empty: db.empty,
    }));
    const truncated = rows.length > opts.maxRows;
    const limited = truncated ? rows.slice(0, opts.maxRows) : rows;
    return { mode: "databases" as const, rows: limited, rowCount: limited.length, truncated };
  });
}

/** ping：仅供「测试连通性」使用。 */
export async function mongoPing(client: MongoClient, database?: string): Promise<string> {
  await ensureConnected(client);
  return withMongoErrors(client, async () => {
    const reply = (await client.db(database).command({ ping: 1 })) as { ok?: number };
    return `ping → ok=${reply.ok ?? 1}`;
  });
}

const WALK_MAX_DEPTH = 4;

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (Buffer.isBuffer(value)) return "binary";
  if (typeof value === "object") {
    const bsonType = (value as { _bsontype?: string })._bsontype;
    return bsonType ? bsonType.toLowerCase() : "object";
  }
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !Buffer.isBuffer(value) &&
    !(value as { _bsontype?: string })._bsontype
  );
}

function collectFields(
  doc: Record<string, unknown>,
  prefix: string,
  acc: Map<string, Set<string>>,
  depth: number,
): void {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    let types = acc.get(path);
    if (!types) {
      types = new Set<string>();
      acc.set(path, types);
    }
    types.add(typeName(value));

    if (depth >= WALK_MAX_DEPTH) continue;
    if (Array.isArray(value)) {
      const firstObject = value.find((item) => isPlainObject(item));
      if (firstObject) collectFields(firstObject, `${path}[]`, acc, depth + 1);
    } else if (isPlainObject(value)) {
      collectFields(value, path, acc, depth + 1);
    }
  }
}

export interface MongoSchemaOptions {
  database: string;
  collection: string;
  sampleSize: number;
  maxRows: number;
  timeoutMs: number;
}

/** 采样若干文档，推断字段路径与类型。 */
export async function mongoSchema(
  client: MongoClient,
  opts: MongoSchemaOptions,
): Promise<MongoSchemaResult> {
  await ensureConnected(client);
  return withMongoErrors(client, async () => {
    const docs = await client
      .db(opts.database)
      .collection(opts.collection)
      .find({}, { maxTimeMS: opts.timeoutMs })
      .limit(opts.sampleSize)
      .toArray();

    const acc = new Map<string, Set<string>>();
    const presence = new Map<string, number>();
    for (const doc of docs) {
      const local = new Map<string, Set<string>>();
      collectFields(doc as Record<string, unknown>, "", local, 0);
      for (const [path, types] of local) {
        let target = acc.get(path);
        if (!target) {
          target = new Set<string>();
          acc.set(path, target);
        }
        for (const type of types) target.add(type);
        presence.set(path, (presence.get(path) ?? 0) + 1);
      }
    }

    const allRows: MongoSchemaRow[] = [...acc.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([field, types]) => ({
        field,
        types: [...types].sort(),
        present: presence.get(field) ?? 0,
      }));
    const rows = allRows.slice(0, opts.maxRows);

    return { collection: opts.collection, sampleSize: docs.length, rows, rowCount: rows.length };
  });
}
