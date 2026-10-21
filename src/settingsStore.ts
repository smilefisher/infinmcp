import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const SETTINGS_FILE = "settings.json";

/**
 * 运行时设置：由 Web 控制台（admin）修改并热生效，优先级高于配置文件的默认值。
 * 目前只有一个开关：是否允许 AI 通过 MCP 工具新增 / 更新 / 删除连接。
 */
export interface RuntimeSettings {
  allowAiConnectionWrites?: boolean;
}

/** 校验 HTTP 请求体 / 文件内容；未知字段被忽略（容错优先）。 */
export const SettingsPatchSchema = z.object({
  allowAiConnectionWrites: z.boolean().optional(),
});

export function settingsFilePath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

/** 读取 settings.json；文件不存在 / 损坏时返回空对象（不抛错，容错优先）。 */
export function readSettings(dataDir: string): RuntimeSettings {
  const file = settingsFilePath(dataDir);
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
  if (text === "") return {};

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = SettingsPatchSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/** 原子写入 settings.json（0600）。 */
export function writeSettings(dataDir: string, settings: RuntimeSettings): void {
  mkdirSync(dataDir, { recursive: true });
  const file = settingsFilePath(dataDir);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod，忽略
  }
}

/** 合并并落盘设置；返回合并后的完整设置。 */
export function updateSettings(dataDir: string, patch: RuntimeSettings): RuntimeSettings {
  const merged = { ...readSettings(dataDir), ...patch };
  writeSettings(dataDir, merged);
  return merged;
}
