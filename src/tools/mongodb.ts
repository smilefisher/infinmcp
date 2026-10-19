import { z } from "zod";
import {
  mongoAggregate,
  mongoFind,
  mongoListCollections,
  mongoSchema,
} from "../connections/mongodb.js";
import { checkMongoFilter, checkMongoPipeline, effectiveRowLimit } from "../readonly.js";
import type { ToolContext, ToolDefinition } from "./types.js";

const jsonObject = z.record(z.string(), z.unknown());
const pipelineStage = z.record(z.string(), z.unknown());

/**
 * 解析要操作的库：参数优先，其次连接配置里的默认库。
 * 同时校验连接类型，避免用错工具时抛出误导性的「未指定 database」。
 */
function resolveDatabase(ctx: ToolContext, connection: string, requested: unknown): string | undefined {
  if (typeof requested === "string" && requested !== "") return requested;
  const config = ctx.connections.getConfig(connection);
  if (config.type !== "mongodb") {
    throw new Error(
      `连接 "${connection}" 的类型是 ${config.type}，不能用于 MongoDB 工具；请改用对应的 ${config.type} 工具`,
    );
  }
  return config.database;
}

export const mongoFindTool: ToolDefinition = {
  name: "mongo_find",
  title: "MongoDB 查询文档",
  description:
    "在指定集合上执行只读查询（find）。支持 filter / projection / sort / skip / limit；" +
    "禁止 $where 等服务端脚本。返回条数受服务端 maxRows 限制。可用 {\"$oid\":\"...\"} / {\"$date\":\"ISO\"} 表示 ObjectId / 日期。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    collection: z.string().describe("集合名"),
    database: z.string().optional().describe("库名；缺省使用连接配置里的默认库"),
    filter: jsonObject.optional().describe("查询条件，例如 {\"status\":\"active\"}"),
    projection: jsonObject.optional().describe("字段投影，例如 {\"name\":1,\"_id\":0}"),
    sort: z.record(z.string(), z.union([z.number(), z.string()])).optional().describe("排序，例如 {\"createdAt\":-1}"),
    skip: z.number().int().min(0).optional().describe("跳过条数"),
    limit: z.number().int().positive().optional().describe("返回条数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const collection = typeof args.collection === "string" ? args.collection : "";
    if (!collection) throw new Error("缺少参数 collection");

    const database = resolveDatabase(ctx, connection, args.database);
    if (!database) {
      throw new Error("未指定 database，且连接配置里也没有默认库；请在参数中提供 database");
    }

    const filterCheck = checkMongoFilter(args.filter);
    if (!filterCheck.ok) throw new Error(`拒绝执行: ${filterCheck.reason}`);

    const limit = effectiveRowLimit(
      typeof args.limit === "number" ? args.limit : undefined,
      ctx.config.limits.maxRows,
    );

    const client = ctx.connections.mongoClient(connection);
    const result = await mongoFind(client, {
      database,
      collection,
      filter: args.filter,
      projection: args.projection,
      sort: args.sort,
      skip: typeof args.skip === "number" ? args.skip : undefined,
      limit,
      maxRows: limit,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `库.集合: ${database}.${collection}\n` +
      `文档数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.documents, null, 2)}`,
      structured: { documents: result.documents, rowCount: result.rowCount, truncated: result.truncated },
      connection,
      rowCount: result.rowCount,
      summary: `mongo_find on ${connection} ${database}.${collection} (${result.rowCount} docs)`,
    };
  },
};

export const mongoAggregateTool: ToolDefinition = {
  name: "mongo_aggregate",
  title: "MongoDB 聚合查询",
  description:
    "在指定集合上执行只读聚合管道。禁止写入阶段 $out / $merge，以及 $where / $function / $accumulator 等服务端脚本；" +
    "会在管道末尾追加 $limit 以限制返回量（受服务端 maxRows 约束）。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    collection: z.string().describe("集合名"),
    pipeline: z.array(pipelineStage).describe("聚合管道阶段数组，例如 [{\"$match\":{...}},{\"$group\":{...}}]"),
    database: z.string().optional().describe("库名；缺省使用连接配置里的默认库"),
    limit: z.number().int().positive().optional().describe("返回条数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const collection = typeof args.collection === "string" ? args.collection : "";
    if (!collection) throw new Error("缺少参数 collection");
    const pipeline = Array.isArray(args.pipeline) ? (args.pipeline as unknown[]) : [];

    const database = resolveDatabase(ctx, connection, args.database);
    if (!database) {
      throw new Error("未指定 database，且连接配置里也没有默认库；请在参数中提供 database");
    }

    const pipelineCheck = checkMongoPipeline(pipeline);
    if (!pipelineCheck.ok) throw new Error(`拒绝执行: ${pipelineCheck.reason}`);

    const limit = effectiveRowLimit(
      typeof args.limit === "number" ? args.limit : undefined,
      ctx.config.limits.maxRows,
    );

    const client = ctx.connections.mongoClient(connection);
    const result = await mongoAggregate(client, {
      database,
      collection,
      pipeline,
      maxRows: limit,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `库.集合: ${database}.${collection}\n` +
      `阶段数: ${pipeline.length}\n` +
      `文档数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.documents, null, 2)}`,
      structured: { documents: result.documents, rowCount: result.rowCount, truncated: result.truncated },
      connection,
      rowCount: result.rowCount,
      summary: `mongo_aggregate on ${connection} ${database}.${collection} (${result.rowCount} docs)`,
    };
  },
};

export const mongoListCollectionsTool: ToolDefinition = {
  name: "mongo_list_collections",
  title: "MongoDB 集合/库列表",
  description:
    "列出集合：提供 database（或连接有默认库）时返回该库的集合；未指定库时返回该实例上的所有数据库。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    database: z.string().optional().describe("库名；缺省使用连接配置里的默认库；都没有时列出所有数据库"),
    limit: z.number().int().positive().optional().describe("返回条数上限（不会超过服务端 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");

    const database = resolveDatabase(ctx, connection, args.database);
    const limit = effectiveRowLimit(
      typeof args.limit === "number" ? args.limit : undefined,
      ctx.config.limits.maxRows,
    );

    const client = ctx.connections.mongoClient(connection);
    const result = await mongoListCollections(client, {
      database,
      maxRows: limit,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `模式: ${result.mode}${database ? `（${database}）` : ""}\n` +
      `行数: ${result.rowCount}${result.truncated ? "（已截断）" : ""}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.rows, null, 2)}`,
      structured: { mode: result.mode, rows: result.rows, rowCount: result.rowCount, truncated: result.truncated },
      connection,
      rowCount: result.rowCount,
      summary: `mongo_list_collections on ${connection} (${result.mode})`,
    };
  },
};

export const mongoSchemaTool: ToolDefinition = {
  name: "mongo_schema",
  title: "MongoDB 结构采样",
  description:
    "采样若干文档推断集合的字段结构（字段路径、出现的 BSON 类型、命中样本数）。适合在不确定字段名时先看一眼结构。",
  inputSchema: {
    connection: z.string().describe("连接名，见 list_connections"),
    collection: z.string().describe("集合名"),
    database: z.string().optional().describe("库名；缺省使用连接配置里的默认库"),
    sample: z.number().int().positive().optional().describe("采样文档数，默认 50（不会超过 maxRows）"),
  },
  async handler(args, ctx) {
    const connection = typeof args.connection === "string" ? args.connection : "";
    if (!connection) throw new Error("缺少参数 connection");
    const collection = typeof args.collection === "string" ? args.collection : "";
    if (!collection) throw new Error("缺少参数 collection");

    const database = resolveDatabase(ctx, connection, args.database);
    if (!database) {
      throw new Error("未指定 database，且连接配置里也没有默认库；请在参数中提供 database");
    }

    const sampleSize = effectiveRowLimit(
      typeof args.sample === "number" ? args.sample : 50,
      ctx.config.limits.maxRows,
    );

    const client = ctx.connections.mongoClient(connection);
    const result = await mongoSchema(client, {
      database,
      collection,
      sampleSize,
      maxRows: ctx.config.limits.maxRows,
      timeoutMs: ctx.config.limits.timeoutMs,
    });

    const header =
      `连接: ${connection}\n` +
      `库.集合: ${database}.${collection}\n` +
      `采样文档: ${result.sampleSize}\n` +
      `字段数: ${result.rowCount}`;

    return {
      text: `${header}\n\n${JSON.stringify(result.rows, null, 2)}`,
      structured: { collection: result.collection, sampleSize: result.sampleSize, fields: result.rows },
      connection,
      rowCount: result.rowCount,
      summary: `mongo_schema on ${connection} ${database}.${collection} (${result.sampleSize} sampled)`,
    };
  },
};
