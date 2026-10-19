#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { Command } from "commander";
import { ConfigError, loadConfig, summarizeConfig, type LoadedConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { Logger } from "./logging.js";
import { Runtime } from "./runtime.js";
import { runStdio } from "./server.js";
import { VERSION } from "./version.js";

// 先加载 .env，供配置中的 {env:...} 占位符解析
// quiet: 避免 dotenv 向 stdout 打印提示（stdio MCP 下 stdout 只允许协议数据）
loadDotenv({ quiet: true });

interface CommonOptions {
  config?: string;
  dataDir?: string;
}

function readConfig(options: CommonOptions): LoadedConfig {
  try {
    return loadConfig({ configPath: options.config, dataDir: options.dataDir });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`错误: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function printSummary(config: LoadedConfig, stream: NodeJS.WriteStream = process.stdout): void {
  for (const line of summarizeConfig(config)) {
    stream.write(`${line}\n`);
  }
  for (const warning of config.warnings) {
    stream.write(`警告: ${warning}\n`);
  }
}

function withCommonOptions(command: Command): Command {
  return command
    .option("-c, --config <path>", "配置文件路径（默认 ./infinmcp.config.json 或 ~/.config/infinmcp/config.json）")
    .option("-d, --data-dir <path>", "数据目录，存放可写的 connections.json 等（默认 ~/.config/infinmcp）");
}

const program = new Command();

program
  .name("infinmcp")
  .description("只读数据库 MCP 服务（MySQL / Doris / Redis / MongoDB）")
  .version(VERSION, "-v, --version", "打印版本号")
  .showHelpAfterError();

withCommonOptions(program.command("config"))
  .description("加载并打印配置摘要（脱敏，不含 Key / 密码）")
  .action((options: CommonOptions) => {
    printSummary(readConfig(options));
  });

withCommonOptions(program.command("mcp"))
  .description("以 stdio 方式运行 MCP 服务（本地调试）")
  .action(async (options: CommonOptions) => {
    const config = readConfig(options);
    // stdio 模式下 stdout 只允许协议数据，摘要与提示一律走 stderr
    printSummary(config, process.stderr);
    const logger = new Logger({ file: config.logs.file });
    await runStdio(config, logger);
  });

withCommonOptions(program.command("serve"))
  .description("以 HTTP 方式运行 MCP 服务 + Web 页面（多人接入）")
  .option("-H, --host <host>", "监听地址（覆盖配置里的 server.host）")
  .option("-p, --port <port>", "监听端口（覆盖配置里的 server.port）")
  .action(async (options: CommonOptions & { host?: string; port?: string }) => {
    const config = readConfig(options);
    if (config.server.apiKeys.length === 0) {
      process.stderr.write("错误: serve 模式需要至少配置一个 API Key（server.apiKeys）。\n");
      process.stderr.write("提示: 用 `openssl rand -hex 32` 生成密钥，在配置文件中以 {env:VAR} 引用。\n");
      process.exit(1);
    }
    printSummary(config);

    const host = options.host ?? config.server.host;
    const port = options.port ? Number(options.port) : config.server.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`错误: 端口不合法: ${options.port}\n`);
      process.exit(1);
    }

    const logger = new Logger({ file: config.logs.file });
    const runtime = new Runtime(config);
    const server = createHttpServer({ runtime, logger });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    }).catch((error: unknown) => {
      process.stderr.write(`错误: 无法监听 ${host}:${port} — ${(error as Error).message}\n`);
      process.exit(1);
    });

    const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    process.stdout.write(`\nHTTP 服务已启动:\n`);
    process.stdout.write(`  Web 页面:   http://${shown}:${port}/\n`);
    process.stdout.write(`  MCP 端点:   POST http://${shown}:${port}/mcp  (Authorization: Bearer <API Key>)\n`);
    process.stdout.write(`  健康检查:   GET  http://${shown}:${port}/healthz\n`);
    process.stdout.write(`  API Keys:   ${config.server.apiKeys.map((k) => `${k.name}(${k.role})`).join(", ")}\n`);

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`\n收到 ${signal}，正在关闭…\n`);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.close();
      process.exit(0);
    };
    process.once("SIGINT", () => void shutdown("SIGINT"));
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`错误: ${message}\n`);
  process.exit(1);
});
