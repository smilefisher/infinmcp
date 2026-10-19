import { safeConnectionInfo } from "../config.js";
import type { ToolDefinition } from "./types.js";

/** 列出当前配置中的所有连接（不含口令）。 */
export const listConnectionsTool: ToolDefinition = {
  name: "list_connections",
  title: "List connections",
  description:
    "列出 infinmcp 当前可用的数据库连接：名称、类型、目标地址与默认库。不会返回任何口令或密钥。",
  inputSchema: {},
  async handler(_args, ctx) {
    const names = Object.keys(ctx.config.connections);
    const infos = names.map((name) => safeConnectionInfo(name, ctx.config.connections[name]!));

    if (infos.length === 0) {
      return {
        text: "当前没有任何已配置的数据库连接。",
        structured: { connections: [] },
        rowCount: 0,
        summary: "0 connections",
      };
    }

    const lines = infos.map((info) => {
      const target = info.type === "mongodb" ? info.uri : `${info.host}:${info.port}`;
      const db = info.database ?? (info.db !== undefined ? `db=${info.db}` : undefined);
      return `- ${info.name} [${info.type}] ${target}${db ? ` (${db})` : ""}`;
    });

    return {
      text: `可用连接（${infos.length}）:\n${lines.join("\n")}`,
      structured: { connections: infos },
      rowCount: infos.length,
      summary: `${infos.length} connections`,
    };
  },
};
