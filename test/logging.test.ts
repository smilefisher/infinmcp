import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/logging.js";

function tempLogFile(): string {
  return join(mkdtempSync(join(tmpdir(), "infinmcp-log-")), "logs.jsonl");
}

describe("Logger", () => {
  it("落盘 JSONL、推送订阅者、维护环形缓冲", () => {
    const file = tempLogFile();
    const logger = new Logger({ file, maxBuffer: 2 });
    const seen: string[] = [];
    const unsubscribe = logger.subscribe((entry) => seen.push(entry.tool));

    logger.record({ user: "alice", tool: "a", status: "ok", durationMs: 1 });
    logger.record({ user: "alice", tool: "b", status: "ok", durationMs: 1 });
    logger.record({ user: "alice", tool: "c", status: "ok", durationMs: 1 });
    unsubscribe();
    logger.record({ user: "alice", tool: "d", status: "ok", durationMs: 1 });

    const lines = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toHaveLength(4);
    expect(lines[0].user).toBe("alice");
    expect(lines[0].ts).toBeTypeOf("string");
    expect(seen).toEqual(["a", "b", "c"]);
    expect(logger.recent(2).map((entry) => entry.tool)).toEqual(["c", "d"]);
  });
});
