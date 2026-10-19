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
      expect(tools.tools.map((tool) => tool.name)).toContain("list_connections");

      const result = await client.callTool({ name: "list_connections", arguments: {} });
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("main");
      expect(content[0]?.text).toContain("mysql");
    } finally {
      await client.close();
    }

    const lines = readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const last = lines.at(-1);
    expect(last.tool).toBe("list_connections");
    expect(last.user).toBe("local");
    expect(last.status).toBe("ok");
  }, 30000);
});
