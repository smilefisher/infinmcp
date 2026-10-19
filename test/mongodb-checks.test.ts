import { describe, expect, it } from "vitest";
import { checkMongoFilter, checkMongoPipeline } from "../src/readonly.js";

describe("checkMongoPipeline", () => {
  it("允许常见只读阶段", () => {
    expect(checkMongoPipeline([]).ok).toBe(true);
    expect(
      checkMongoPipeline([
        { $match: { status: "active" } },
        { $group: { _id: "$type", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: 10 },
      ]).ok,
    ).toBe(true);
    expect(checkMongoPipeline([{ $lookup: { from: "orders", localField: "_id", foreignField: "uid", as: "o" } }]).ok).toBe(
      true,
    );
  });

  it("拒绝 $out / $merge（含嵌套）", () => {
    expect(checkMongoPipeline([{ $match: {} }, { $out: "copy" }]).ok).toBe(false);
    expect(checkMongoPipeline([{ $merge: { into: "copy" } }]).ok).toBe(false);
    const nested = checkMongoPipeline([{ $facet: { x: [{ $out: "y" }] } }]);
    expect(nested.ok).toBe(false);
    expect(nested.reason).toContain("$out");
  });

  it("拒绝服务端脚本阶段", () => {
    expect(checkMongoPipeline([{ $match: { $where: "this.x" } }]).ok).toBe(false);
    expect(checkMongoPipeline([{ $addFields: { y: { $function: {} } } }]).ok).toBe(false);
    expect(checkMongoPipeline([{ $group: { _id: null, v: { $accumulator: {} } } }]).ok).toBe(false);
  });

  it("非数组 pipeline 被拒绝", () => {
    expect(checkMongoPipeline({ $match: {} }).ok).toBe(false);
  });
});

describe("checkMongoFilter", () => {
  it("允许普通查询条件", () => {
    expect(checkMongoFilter(undefined).ok).toBe(true);
    expect(checkMongoFilter({}).ok).toBe(true);
    expect(checkMongoFilter({ status: "active", age: { $gt: 18 } }).ok).toBe(true);
    expect(checkMongoFilter({ $or: [{ a: 1 }, { b: 2 }] }).ok).toBe(true);
  });

  it("拒绝 $where（含嵌套）", () => {
    expect(checkMongoFilter({ $where: "this.a > 1" }).ok).toBe(false);
    expect(checkMongoFilter({ $or: [{ $where: "1" }] }).ok).toBe(false);
  });

  it("非对象 filter 被拒绝", () => {
    expect(checkMongoFilter([{ a: 1 }]).ok).toBe(false);
    expect(checkMongoFilter("x").ok).toBe(false);
  });
});
