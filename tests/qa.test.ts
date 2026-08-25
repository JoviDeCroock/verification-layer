import { describe, expect, it } from "vitest";
import {
  missionSchema,
  qaExecutorSchema,
  type ChangeContract,
} from "../packages/core/src/index.js";
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
    const missions = generateMissions(contract);
    expect(missions.map((mission) => mission.id)).toEqual([
      "happy-path",
      "authorization",
      "duplicate-submission",
      "expiration",
      "regression",
      "mobile-journey",
    ]);
    expect(missions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "duplicate-submission",
          generation: expect.objectContaining({
            method: "deterministic",
            generator: "executable-trust-layer/intent-heuristics",
            version: "1",
            input_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          }),
        }),
      ]),
    );
    expect(missions[0]!.generation!.input_sha256).toBe(
      generateMissions(contract)[0]!.generation!.input_sha256,
    );
  });

  it("requires complete provider provenance for model generation and execution", () => {
    const mission = {
      id: "boundary",
      title: "Boundary journey",
      objective: "Exercise a boundary",
      derived_from: ["approved behavior"],
      generation: {
        method: "model",
        generator: "mission-proposer",
        version: "1",
        input_sha256: "a".repeat(64),
      },
    };
    expect(missionSchema.safeParse(mission).success).toBe(false);
    expect(
      missionSchema.safeParse({
        ...mission,
        generation: {
          ...mission.generation,
          provider: "openai",
          model: "gpt-5.6-terra",
          prompt_sha256: "b".repeat(64),
        },
      }).success,
    ).toBe(true);
    expect(
      qaExecutorSchema.safeParse({
        method: "model",
        adapter: "browser-agent",
        version: "1",
      }).success,
    ).toBe(false);
  });

  it("executes approved mission artifacts without adding runtime model judgment", () => {
    const approvedMission = missionSchema.parse({
      id: "approved-boundary",
      title: "Approved boundary",
      objective: "Exercise the approved boundary",
      derived_from: ["model proposal approved by product owner"],
      generation: {
        method: "model",
        generator: "mission-proposer",
        version: "1",
        input_sha256: "a".repeat(64),
        provider: "openai",
        model: "gpt-5.6-terra",
        prompt_sha256: "b".repeat(64),
      },
    });
    const contract = {
      version: 1,
      id: "approved-mission",
      intent: "Use the approved mission exactly",
      expected_behaviors: [
        { id: "boundary", description: "the boundary holds", evidence: ["preview-qa"] },
      ],
      affected_surfaces: ["app"],
      risks: ["mobile ui"],
      required_evidence: ["preview-qa"],
      excluded: [],
      qa_missions: [approvedMission],
      approval: { status: "draft" },
    } satisfies ChangeContract;
    expect(generateMissions(contract)).toEqual([approvedMission]);
  });
});
