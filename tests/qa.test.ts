import { describe, expect, it } from "vitest";
import type { ChangeContract } from "../packages/core/src/index.js";
import { generateMissions } from "../packages/qa/src/index.js";

describe("intent-derived QA", () => {
  it("derives boundary missions from behavior and risk rather than implementation narration", () => {
    const contract: ChangeContract = {
      version: 1,
      id: "invitations",
      intent: "Invite team members",
      expected_behaviors: [
        { id: "happy-path", description: "admins can invite users", evidence: ["preview-qa"] },
        {
          id: "authorization",
          description: "non-admins cannot invite users",
          evidence: ["preview-qa"],
        },
        {
          id: "duplicate-submission",
          description: "duplicate invitations do not create duplicates",
          evidence: ["preview-qa"],
        },
        {
          id: "expiration",
          description: "invitations expire after seven days",
          evidence: ["preview-qa"],
        },
        { id: "regression", description: "signup remains unchanged", evidence: ["preview-qa"] },
      ],
      affected_surfaces: ["team"],
      risks: ["mobile ui"],
      required_evidence: ["preview-qa"],
      excluded: [],
      approval: {
        status: "approved",
        approved_by: "test-owner",
        approved_at: "2026-08-25T04:00:00.000Z",
        method: "local",
      },
    };
    expect(generateMissions(contract).map((mission) => mission.id)).toEqual([
      "happy-path",
      "authorization",
      "duplicate-submission",
      "expiration",
      "regression",
      "mobile-journey",
    ]);
  });
});
