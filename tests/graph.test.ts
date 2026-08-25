import { describe, expect, it } from "vitest";
import type { ChangeContract, TrustConfig } from "../packages/core/src/index.js";
import { createVerificationPlan } from "../packages/graph/src/index.js";

const config: TrustConfig = {
  version: 1,
  repository: { name: "fixture", root: "." },
  knowledge: { sources: [] },
  checks: [
    {
      id: "auth-test",
      kind: "test",
      command: "test",
      scope: ["src/auth/**"],
      tags: ["authorization"],
      required: false,
      timeout_ms: 1000,
    },
    {
      id: "billing-test",
      kind: "test",
      command: "test",
      scope: ["src/billing/**"],
      tags: [],
      required: false,
      timeout_ms: 1000,
    },
  ],
  invariants: [
    {
      id: "auth-size",
      scope: ["src/auth/**"],
      command: "size",
      unit: "bytes",
      baseline: 100,
      threshold: { regression: 10 },
      timeout_ms: 1000,
    },
  ],
  verifiers: [],
  surfaces: [
    {
      id: "auth",
      paths: ["src/auth/**"],
      requires: ["auth-test", "auth-size"],
      risks: ["authorization"],
      depends_on: [],
    },
  ],
  qa: {
    enabled: true,
    adapter: "qa.ts",
    preview_url: "http://localhost:3000",
    instructions: [],
    screenshot: false,
    timeout_ms: 1000,
  },
};

const contract: ChangeContract = {
  version: 1,
  id: "login",
  intent: "Change login",
  expected_behaviors: [
    {
      id: "authorization",
      description: "non-admins cannot enter",
      evidence: ["preview-qa"],
    },
  ],
  affected_surfaces: [],
  risks: ["authorization"],
  required_evidence: ["preview-qa"],
  excluded: [],
  approval: {
    status: "approved",
    approved_by: "test-owner",
    approved_at: "2026-08-25T04:00:00.000Z",
    method: "local",
  },
};

describe("verification graph", () => {
  it("selects scoped and risk evidence without running unrelated checks", () => {
    const plan = createVerificationPlan(config, contract, ["src/auth/login.ts"]);
    expect(plan.affected_surfaces).toEqual(["auth"]);
    expect(plan.selected_checks).toEqual(["auth-test"]);
    expect(plan.selected_invariants).toEqual(["auth-size"]);
    expect(plan.selected_checks).not.toContain("billing-test");
    expect(plan.qa_required).toBe(true);
  });
});
