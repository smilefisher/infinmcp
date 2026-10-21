import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("stdio MCP server", () => {
  it("可列出工具、调用 list_connections，并写入含 user 的日志", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infinmcp-stdio-"));
    const logFile = join(dir, "logs.jsonl");
    const configFile = join(dir, "config.json");
    writeFileSync(
      configFile,
      JSON.stringify({
        server: { apiKeys: [] },
        connections: {
          main: { type: "mysql", host: "127.0.0.1", user: "ro", database: "app" },
        },
        logs: { file: logFile },
      }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entrypoint, "mcp", "-c", configFile],
      env: { ...process.env } as Record<string, string>,
    });
    const client = new Client({ name: "infinmcp-test", version: "0.0.0" });

    try {
      await client.connect(transport);

      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("list_connections");
      expect(names).toContain("create_connection");

      const result = await client.callTool({ name: "list_connections", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("main");
      expect(content[0]?.text).toContain("mysql");

      // stdio 模式不注入连接管理能力：写工具可见但会明确报错（只读）
      const writeAttempt = await client.callTool({
        name: "create_connection",
        arguments: { name: "extra", type: "redis", host: "127.0.0.1" },
      });
      const writeText = (writeAttempt.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(writeAttempt.isError).toBe(true);
      expect(writeText).toContain("stdio");
    } finally {
      await client.close();
    }

    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.some((entry) => entry.tool === "list_connections" && entry.user === "local" && entry.status === "ok")).toBe(true);
    const last = lines.at(-1);
    expect(last.tool).toBe("create_connection");
    expect(last.user).toBe("local");
    expect(last.status).toBe("error");
  }, 30000);
});
