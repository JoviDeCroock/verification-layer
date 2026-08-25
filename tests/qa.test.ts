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
        "admins can invite users",
        "non-admins cannot invite users",
        "duplicate invitations do not create duplicates",
        "invitations expire after seven days",
        "signup remains unchanged",
      ],
      affected_surfaces: ["team"],
      risks: ["mobile ui"],
      required_evidence: ["preview-qa"],
      excluded: [],
      approval: { status: "approved" },
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
