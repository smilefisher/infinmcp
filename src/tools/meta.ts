import { safeConnectionInfo } from "../config.js";
import type { ToolDefinition } from "./types.js";

/** 列出当前配置中的所有连接（不含口令）。 */
export const listConnectionsTool: ToolDefinition = {
  name: "list_connections",
  title: "List connections",
  description:
    "列出 infinmcp 当前可用的数据库连接：名称、类型、目标地址、默认库，以及可选标签 " +
    "env（prod / test / dev）、readonly（数据库账号是否只读；false 表示账号可能有写权限）、" +
    "maxRows（该连接实际生效的行数上限）。这些标签仅作参考，服务端不会据此切换环境或放行写操作。" +
    "不会返回任何口令或密钥。",
  inputSchema: {},
  async handler(_args, ctx) {
    const names = Object.keys(ctx.config.connections);
    const infos = names.map((name) =>
      safeConnectionInfo(name, ctx.config.connections[name]!, ctx.config.limits.maxRows),
    );

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
      const tags: string[] = [];
      if (info.env) tags.push(`env=${info.env}`);
      if (info.readonly !== undefined) tags.push(`readonly=${info.readonly}`);
      if (ctx.config.connections[info.name]!.maxRows !== undefined) tags.push(`maxRows=${info.maxRows}`);
      const suffix = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
      return `- ${info.name} [${info.type}] ${target}${db ? ` (${db})` : ""}${suffix}`;
    });

    return {
      text: `可用连接（${infos.length}）:\n${lines.join("\n")}`,
      structured: { connections: infos },
      rowCount: infos.length,
      summary: `${infos.length} connections`,
    };
  },
};
