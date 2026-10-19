import { describe, expect, it } from "vitest";
import { ConnectionManager } from "../src/connections/manager.js";
import type { ConnectionConfig, LoadedConfig } from "../src/config.js";
import type { Logger } from "../src/logging.js";
import { mongoFindTool, mongoListCollectionsTool } from "../src/tools/mongodb.js";
import { mysqlQueryTool } from "../src/tools/mysql.js";
import { dorisQueryTool } from "../src/tools/doris.js";
import type { ToolContext } from "../src/tools/types.js";

/** 构造一个最小上下文；这些用例都在创建驱动句柄之前就应抛错，因此不会真的连库。 */
function makeContext(connections: Record<string, ConnectionConfig>): ToolContext {
  return {
    config: { limits: { maxRows: 100, timeoutMs: 1000 } } as unknown as LoadedConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger,
    connections: new ConnectionManager({ connections, timeoutMs: 1000 }),
    user: "tester",
  };
}

const mysqlConn: ConnectionConfig = { type: "mysql", host: "10.0.0.1", user: "ro", database: "app" };
const dorisConn: ConnectionConfig = { type: "doris", host: "10.0.0.2", user: "ro", database: "app" };
const mongoNoDb: ConnectionConfig = { type: "mongodb", uri: "mongodb://127.0.0.1:27017" };
const mongoWithDb: ConnectionConfig = { type: "mongodb", uri: "mongodb://127.0.0.1:27017", database: "app" };

describe("连接类型用错时的报错", () => {
  it("mongo_find 用 MySQL 连接时报类型错误，而不是误导性的「未指定 database」", async () => {
    const ctx = makeContext({ main: mysqlConn });
    await expect(mongoFindTool.handler({ connection: "main", collection: "users" }, ctx)).rejects.toThrow(
      /类型是 mysql，不能用于 MongoDB 工具/,
    );
  });

  it("doris_query 用 MySQL 连接时报类型错误", async () => {
    const ctx = makeContext({ main: mysqlConn });
    await expect(dorisQueryTool.handler({ connection: "main", sql: "SELECT 1" }, ctx)).rejects.toThrow(
      /类型是 mysql，不能作为 Doris 使用/,
    );
  });

  it("mysql_query 用 Doris 连接时报类型错误", async () => {
    const ctx = makeContext({ warehouse: dorisConn });
    await expect(mysqlQueryTool.handler({ connection: "warehouse", sql: "SELECT 1" }, ctx)).rejects.toThrow(
      /类型是 doris，不能作为 MySQL 使用/,
    );
  });

  it("mongo_list_collections 同样报类型错误", async () => {
    const ctx = makeContext({ main: mysqlConn });
    await expect(mongoListCollectionsTool.handler({ connection: "main" }, ctx)).rejects.toThrow(
      /类型是 mysql/,
    );
  });

  it("显式传了 database 时也能识别类型不匹配", async () => {
    const ctx = makeContext({ main: mysqlConn });
    await expect(
      mongoFindTool.handler({ connection: "main", collection: "users", database: "app" }, ctx),
    ).rejects.toThrow(/类型是 mysql/);
  });

  it("连接不存在时报未知连接（并列出可用连接）", async () => {
    const ctx = makeContext({ main: mysqlConn });
    await expect(mongoFindTool.handler({ connection: "nope", collection: "users" }, ctx)).rejects.toThrow(
      /未知连接 "nope"/,
    );
  });

  it("MongoDB 连接缺默认库时仍提示需要 database", async () => {
    const ctx = makeContext({ docs: mongoNoDb });
    await expect(mongoFindTool.handler({ connection: "docs", collection: "users" }, ctx)).rejects.toThrow(
      /未指定 database/,
    );
  });

  it("有默认库时不报库缺失（继续走到真正连库，这里只断言不是库缺失错误）", async () => {
    const ctx = makeContext({ docs: mongoWithDb });
    const error = await mongoFindTool
      .handler({ connection: "docs", collection: "users" }, ctx)
      .then(() => null)
      .catch((err: unknown) => (err instanceof Error ? err.message : String(err)));
    expect(error).not.toBeNull();
    expect(error).not.toMatch(/未指定 database/);
    expect(error).not.toMatch(/类型是/);
  });
});
