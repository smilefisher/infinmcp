import type { LoadedConfig } from "./config.js";
import { ConnectionManager } from "./connections/manager.js";
import { diag } from "./logging.js";

/**
 * 进程内的可变运行状态：配置快照 + 连接管理器。
 * Web 改完连接后调用 `reload()` 即可热生效（仅单进程 serve 模式有意义）。
 */
export class Runtime {
  private config: LoadedConfig;
  private connections: ConnectionManager;

  constructor(config: LoadedConfig) {
    this.config = config;
    this.connections = new ConnectionManager({
      connections: config.connections,
      timeoutMs: config.limits.timeoutMs,
    });
  }

  get current(): LoadedConfig {
    return this.config;
  }

  get manager(): ConnectionManager {
    return this.connections;
  }

  /** 用新配置替换旧配置，并关闭旧连接的句柄。 */
  async reload(next: LoadedConfig): Promise<void> {
    const previous = this.connections;
    this.config = next;
    this.connections = new ConnectionManager({
      connections: next.connections,
      timeoutMs: next.limits.timeoutMs,
    });
    try {
      await previous.closeAll();
    } catch (error) {
      diag("warn", `关闭旧连接句柄时出错: ${(error as Error).message}`);
    }
  }

  /** 关闭全部连接句柄。 */
  async close(): Promise<void> {
    await this.connections.closeAll();
  }
}
