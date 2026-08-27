import { describe, expect, it } from "vitest";
import type { TrustReport } from "../src/core/index.js";
import { proposeLearnings } from "../src/learning/index.js";

describe("learning loop", () => {
  it("proposes but does not apply policy changes", () => {
    const report = {
      evidence: [
        {
          id: "qa:duplicate-submission",
          category: "qa",
          status: "failed",
          summary: "Duplicate submission created two invitations.",
        },
      ],
      unknowns: [],
    } as unknown as TrustReport;
    expect(proposeLearnings(report)).toEqual([
      expect.objectContaining({ type: "qa-heuristic", source_evidence: "qa:duplicate-submission" }),
      expect.objectContaining({
        type: "regression-test",
        source_evidence: "qa:duplicate-submission",
      }),
    ]);
  });
});
