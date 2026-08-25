import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TrustReport } from "../packages/core/src/index.js";
import { publishGitHubReport, renderGitHubSummary } from "../packages/cli/src/ci.js";

function report(): TrustReport {
  return {
    version: 1,
    run_id: "change\noutput=forged",
    created_at: "2026-08-25T00:00:00.000Z",
    contract: {
      version: 1,
      id: "change",
      intent: "intent",
      expected_behaviors: [],
      affected_surfaces: [],
      risks: [],
      required_evidence: [],
      excluded: [],
      approval: { status: "draft" },
    },
    plan: {
      version: 1,
      contract_id: "change",
      created_at: "2026-08-25T00:00:00.000Z",
      changed_files: [],
      affected_surfaces: [],
      selected_checks: [],
      selected_invariants: [],
      selected_verifiers: [],
      qa_required: false,
      selection_reasons: {},
    },
    implementation: { changed_files: 0 },
    provenance: {
      repository: {
        head_sha: null,
        branch: null,
        dirty: false,
        changed_files_source: "git",
        base_sha: null,
      },
      digests: {
        policy_sha256: "a".repeat(64),
        contract_sha256: "b".repeat(64),
        plan_sha256: "c".repeat(64),
        change_set_sha256: "d".repeat(64),
      },
      runtime: { trust_version: "0.1.0", node: "22", platform: "test", arch: "test" },
      target: {},
    },
    evidence: [
      {
        id: "claim:unsafe",
        category: "claim",
        status: "failed",
        summary: "Claim failed\n::notice::forged",
      },
    ],
    qa_missions: [],
    unknowns: [],
    learning_proposals: [],
    verdict: "not_trusted",
  };
}

describe("GitHub CI reporting", () => {
  it("renders a bounded reviewer summary", () => {
    const summary = renderGitHubSummary(report());
    expect(summary).toContain("Trust authority");
    expect(summary).toContain("Claim failed ::notice::forged");
    expect(summary).not.toContain("\n::notice::forged");
  });

  it("writes outputs safely and escapes annotations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-github-"));
    const summaryFile = path.join(directory, "summary.md");
    const outputFile = path.join(directory, "output.txt");
    await writeFile(summaryFile, "", "utf8");
    await writeFile(outputFile, "", "utf8");
    const annotations: string[] = [];
    try {
      expect(
        await publishGitHubReport(
          report(),
          "/tmp/report.json",
          {
            ...process.env,
            GITHUB_ACTIONS: "true",
            GITHUB_STEP_SUMMARY: summaryFile,
            GITHUB_OUTPUT: outputFile,
          },
          (line) => annotations.push(line),
        ),
      ).toBe(true);
      expect(await readFile(summaryFile, "utf8")).toContain("Behavior claims");
      const outputs = await readFile(outputFile, "utf8");
      expect(outputs).toContain("trust_run_id=changeoutput=forged\n");
      expect(outputs).not.toContain("\noutput=forged\n");
      expect(annotations).toEqual([
        "::error title=Trust authority::Claim failed%0A::notice::forged",
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
