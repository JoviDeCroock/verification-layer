import { afterEach, describe, expect, it, vi } from "vitest";
import {
  changeContractSchema,
  trustConfigSchema,
  verificationPlanSchema,
} from "../packages/core/src/index.js";
import { runSelectedVerifiers } from "../packages/verifiers/src/index.js";
import { approvalDigest } from "../packages/core/src/provenance.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("typed verifier adapters", () => {
  it("rejects duplicate evidence IDs and dangling surface requirements", () => {
    const result = trustConfigSchema.safeParse({
      version: 1,
      repository: { name: "invalid", root: "." },
      knowledge: { sources: [] },
      checks: [{ id: "duplicate", kind: "static", command: "true", scope: [], tags: [] }],
      invariants: [
        {
          id: "duplicate",
          scope: ["src/**"],
          command: "measure",
          threshold: { max: 1 },
        },
      ],
      surfaces: [
        {
          id: "app",
          paths: ["src/**"],
          requires: ["missing"],
          risks: [],
          depends_on: ["unknown-surface"],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining("declared more than once"),
          expect.stringContaining("requires unknown evidence"),
          expect.stringContaining("depends on unknown surface"),
        ]),
      );
  });

  it("executes no-shell CLI missions and structured HTTP contracts", async () => {
    vi.stubEnv("TRUST_TEST_SECRET", "must-not-be-inherited");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
    );
    const config = trustConfigSchema.parse({
      version: 1,
      repository: { name: "fixture", root: "." },
      knowledge: { sources: [] },
      verifiers: [
        {
          id: "cli",
          kind: "cli",
          scope: ["src/**"],
          tags: [],
          missions: [
            {
              id: "version",
              executable: process.execPath,
              args: [
                "-e",
                "process.stdout.write(`fixture 1.0:${process.env.TRUST_TEST_SECRET ?? 'missing'}`)",
              ],
              expect: {
                exit_code: 0,
                stdout_contains: ["fixture 1.0:missing"],
                stderr_contains: [],
              },
            },
          ],
        },
        {
          id: "requests",
          kind: "requests",
          scope: ["src/**"],
          tags: [],
          base_url: "https://fixture.invalid",
          requests: [
            {
              id: "health",
              method: "GET",
              path: "/health",
              expect: { status: 200, json_path: "$.ok", equals: true },
            },
          ],
        },
      ],
    });
    const contractInput = {
      version: 1,
      id: "fixture",
      intent: "Verify fixture",
      expected_behaviors: [
        { id: "fixture-healthy", description: "fixture remains healthy", evidence: ["requests"] },
      ],
      affected_surfaces: ["fixture"],
      required_evidence: ["requests"],
      approval: {
        status: "approved",
        approved_by: "test-owner",
        approved_at: "2026-08-25T04:00:00.000Z",
        method: "local",
      },
    } as const;
    const contract = changeContractSchema.parse({
      ...contractInput,
      approval: {
        ...contractInput.approval,
        content_sha256: approvalDigest(contractInput),
      },
    });
    const plan = verificationPlanSchema.parse({
      version: 1,
      contract_id: "fixture",
      created_at: new Date().toISOString(),
      changed_files: ["src/index.ts"],
      affected_surfaces: [],
      selected_checks: [],
      selected_invariants: [],
      selected_verifiers: ["cli", "requests"],
      qa_required: false,
      selection_reasons: {},
    });
    const result = await runSelectedVerifiers(
      config,
      plan,
      contract,
      process.cwd(),
      "/tmp/trust-verifier-unit",
    );
    expect(result.evidence).toEqual([
      expect.objectContaining({ id: "cli:version", category: "cli", status: "verified" }),
      expect.objectContaining({
        id: "requests:health",
        category: "request",
        status: "verified",
      }),
    ]);
    expect(result.evidence.find((item) => item.id === "requests:health")?.stdout).toBeUndefined();
  });
});
