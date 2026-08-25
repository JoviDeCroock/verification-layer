import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendAuditJournal,
  createAuditEntry,
  parseAuditJournal,
} from "../packages/core/src/audit.js";
import {
  createReportAttestation,
  generateAuthorityKeyPair,
} from "../packages/core/src/attestations.js";
import {
  computeVerdict,
  trustConfigSchema,
  trustReportSchema,
  type Evidence,
} from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/provenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fixture() {
  const key = generateAuthorityKeyPair();
  const policy = trustConfigSchema.parse({
    version: 1,
    repository: { name: "audit-fixture", root: ".", allow_explicit_changed_files: true },
    knowledge: { sources: ["POLICY_SECRET_SENTINEL"] },
    authority: {
      allow_local_approvals: true,
      require_signed_reports: true,
      trusted_reporters: [{ id: "ci", public_key_base64: key.publicKeyBase64 }],
    },
    checks: [],
    invariants: [],
    surfaces: [],
    verifiers: [],
  });
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const evidence: Evidence[] = [
    {
      id: "claim:behavior",
      source_id: "behavior",
      category: "claim",
      status: "verified",
      summary: "Behavior is supported.",
    },
  ];
  const contract = {
    version: 1 as const,
    id: "audit-change",
    intent: "Exercise audit chaining",
    expected_behaviors: [
      { id: "behavior", description: "Behavior is supported", evidence: ["manual"] },
    ],
    affected_surfaces: [],
    risks: [],
    required_evidence: ["manual"],
    excluded: [],
    approval: {
      status: "approved" as const,
      method: "local" as const,
      approved_by: "fixture",
      approved_at: createdAt,
      content_sha256: "0".repeat(64),
    },
  };
  const plan = {
    version: 1 as const,
    contract_id: contract.id,
    created_at: createdAt,
    changed_files: ["package.json"],
    affected_surfaces: [],
    selected_checks: [],
    selected_invariants: [],
    selected_verifiers: [],
    qa_required: false,
    selection_reasons: {},
  };
  const report = trustReportSchema.parse({
    version: 1,
    run_id: "audit-run",
    created_at: createdAt,
    contract,
    plan,
    implementation: { changed_files: 1 },
    provenance: {
      repository: {
        head_sha: null,
        branch: null,
        dirty: false,
        changed_files_source: "explicit",
        base_sha: null,
      },
      digests: {
        policy_sha256: sha256(policy),
        contract_sha256: sha256(contract),
        plan_sha256: sha256(plan),
        change_set_sha256: "1".repeat(64),
      },
      runtime: {
        trust_version: "0.1.0",
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      target: {},
    },
    evidence,
    qa_missions: [],
    unknowns: [],
    verdict: computeVerdict(evidence),
    learning_proposals: [],
  });
  report.attestation = createReportAttestation(report, "ci", key.privateKeyPem);
  return { policy, report };
}

describe("audit journal", () => {
  it("serializes appenders, links records, anchors the head, and rejects duplicates", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-audit-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "reports.jsonl");
    const { policy, report } = fixture();
    const first = await appendAuditJournal(file, policy, report, { count: 0 });
    const secondReport = structuredClone(report);
    secondReport.run_id = "audit-run-2";
    expect(first.sequence).toBe(1);
    const validation = parseAuditJournal(await readFile(file, "utf8"));
    expect(validation.problems).toEqual([]);
    expect(validation.headSha256).toBe(first.entry_sha256);
    expect(await readFile(file, "utf8")).not.toContain("POLICY_SECRET_SENTINEL");
    await expect(appendAuditJournal(file, policy, report)).rejects.toThrow("already present");
    await expect(
      appendAuditJournal(file, policy, secondReport, { headSha256: "0".repeat(64) }),
    ).rejects.toThrow("external checkpoint");
  });

  it("detects mutation, truncation, and broken links", () => {
    const { policy, report } = fixture();
    const first = createAuditEntry(policy, report, undefined);
    const second = createAuditEntry(policy, { ...report, run_id: "other" }, first);
    const valid = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
    expect(parseAuditJournal(valid).problems).toEqual([]);
    expect(parseAuditJournal(valid.slice(0, -1)).problems).toContain(
      "The audit journal ends with a partial record.",
    );
    const changed = valid.replace('"event":"report-attested"', '"event":"report-attested-x"');
    expect(parseAuditJournal(changed).problems.length).toBeGreaterThan(0);
  });
});
