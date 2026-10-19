// 手动 stdio 冒烟：构建后运行
//   node scripts/stdio-smoke.mjs
// 也可指定配置：CONFIG=./infinmcp.config.json node scripts/stdio-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = ["dist/index.js", "mcp"];
if (process.env.CONFIG) args.push("-c", process.env.CONFIG);

const transport = new StdioClientTransport({ command: process.execPath, args });
const client = new Client({ name: "stdio-smoke", version: "0.0.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  console.log("工具:", tools.tools.map((tool) => tool.name).join(", "));

  const result = await client.callTool({ name: "list_connections", arguments: {} });
  for (const block of result.content) {
    if (block.type === "text") console.log(block.text);
  }
} finally {
  await client.close();
}
