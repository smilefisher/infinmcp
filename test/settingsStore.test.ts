import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSettings, settingsFilePath, updateSettings, writeSettings } from "../src/settingsStore.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "infinmcp-settings-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("settingsStore", () => {
  it("文件不存在时返回空对象", () => {
    expect(readSettings(dataDir)).toEqual({});
  });

  it("写入后可读回，且落盘为 0600", () => {
    writeSettings(dataDir, { allowAiConnectionWrites: true });
    expect(readSettings(dataDir)).toEqual({ allowAiConnectionWrites: true });
    expect(statSync(settingsFilePath(dataDir)).mode & 0o777).toBe(0o600);
    const parsed = JSON.parse(readFileSync(settingsFilePath(dataDir), "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({ allowAiConnectionWrites: true });
  });

  it("updateSettings 覆盖写入并保留其他字段", () => {
    updateSettings(dataDir, { allowAiConnectionWrites: true });
    updateSettings(dataDir, { allowAiConnectionWrites: false });
    expect(readSettings(dataDir)).toEqual({ allowAiConnectionWrites: false });
  });

  it("文件损坏 / 类型不对时容错返回空对象", () => {
    writeFileSync(settingsFilePath(dataDir), "{ not json", "utf8");
    expect(readSettings(dataDir)).toEqual({});
    writeFileSync(settingsFilePath(dataDir), JSON.stringify({ allowAiConnectionWrites: "yes" }), "utf8");
    expect(readSettings(dataDir)).toEqual({});
  });

  it("忽略未知字段", () => {
    writeFileSync(
      settingsFilePath(dataDir),
      JSON.stringify({ allowAiConnectionWrites: true, nope: 1 }),
      "utf8",
    );
    expect(readSettings(dataDir)).toEqual({ allowAiConnectionWrites: true });
  });
});
