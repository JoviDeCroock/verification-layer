import { describe, expect, it } from "vitest";
import { defineInvariant } from "../packages/invariants/src/index.js";

describe("custom invariant API", () => {
  it("supports baseline-aware repository policy", async () => {
    const invariant = defineInvariant({
      id: "signals-core-size",
      scope: ["packages/signals-core/**"],
      measure: async ({ exec }) => exec("pnpm size:signals"),
      assert: ({ baseline = 0, current }) => current <= baseline + 20,
    });
    expect(await invariant.measure({ exec: async () => 118 })).toBe(118);
    expect(invariant.assert({ baseline: 100, current: 118 })).toBe(true);
    expect(invariant.assert({ baseline: 100, current: 121 })).toBe(false);
  });
});
