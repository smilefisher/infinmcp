import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MongoClient } from "mongodb";
import { createMongoClient, mongoListCollections, mongoSchema } from "../src/connections/mongodb.js";
import { checkMongoFilter, checkMongoPipeline } from "../src/readonly.js";

/**
 * 真实 MongoDB 集成测试：仅在设置 INFINMCP_TEST_MONGO 时运行。
 * 例：INFINMCP_TEST_MONGO='mongodb://127.0.0.1:27017/test' npm test
 */
const uri = process.env.INFINMCP_TEST_MONGO;

function databaseFromUri(value: string): string {
  const parsed = new URL(value);
  return parsed.pathname.replace(/^\//, "") || "admin";
}

describe.skipIf(!uri)("MongoDB 集成（需要 INFINMCP_TEST_MONGO）", () => {
  let client: MongoClient;
  const database = uri ? databaseFromUri(uri) : "admin";

  beforeAll(() => {
    client = createMongoClient({ type: "mongodb", uri: uri! }, 5000);
  });

  afterAll(async () => {
    await client.close();
  });

  it("列出集合 / 数据库", async () => {
    const result = await mongoListCollections(client, { database, maxRows: 100, timeoutMs: 5000 });
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("采样结构不报错", async () => {
    const result = await mongoSchema(client, {
      database,
      collection: "system.views",
      sampleSize: 5,
      maxRows: 100,
      timeoutMs: 5000,
    });
    expect(Array.isArray(result.rows)).toBe(true);
  });

  it("写阶段被守卫拒绝", () => {
    expect(checkMongoPipeline([{ $out: "x" }]).ok).toBe(false);
    expect(checkMongoPipeline([{ $merge: { into: "x" } }]).ok).toBe(false);
    expect(checkMongoFilter({ $where: "1" }).ok).toBe(false);
  });
});
