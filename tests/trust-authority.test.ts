import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  computeVerdict,
  trustConfigSchema,
  type ChangeContract,
  type Evidence,
  type TrustConfig,
} from "../src/core/index.js";
import { verifyChange } from "../src/core/verify.js";
import {
  approvalDigest,
  changeSetDigest,
  sha256,
  validateChangedFiles,
} from "../src/core/provenance.js";
import {
  approvalSignatureDigest,
  createReportAttestation,
  generateAuthorityKeyPair,
  signDigest,
  verifyReportAttestation,
} from "../src/core/attestations.js";
import { validateReportSemantics } from "../src/core/report-validation.js";
import { reviewContract } from "../src/contracts/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function config(): TrustConfig {
  return trustConfigSchema.parse({
    version: 1,
    repository: { name: "authority-fixture", root: ".", allow_explicit_changed_files: true },
    knowledge: { sources: [] },
    authority: { allow_local_approvals: true, require_signed_reports: false },
    execution: { allow_shell_commands: true, inherit_environment: false },
    checks: [
      {
        id: "behavior-check",
        kind: "test",
        command: `${process.execPath} -e "process.stdout.write('verified')"`,
        scope: ["src/**"],
        tags: ["state-integrity"],
      },
    ],
    surfaces: [
      {
        id: "app",
        paths: ["src/**"],
        requires: ["behavior-check"],
        risks: ["state integrity"],
        depends_on: [],
      },
    ],
  });
}

function contract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  const value: ChangeContract = {
    version: 1,
    id: "authority-change",
    intent: "Change a user-visible behavior",
    expected_behaviors: [
      {
        id: "behavior-works",
        description: "the behavior works",
        evidence: ["behavior-check"],
      },
    ],
    affected_surfaces: ["app"],
    risks: ["state integrity"],
    required_evidence: ["behavior-check"],
    excluded: [],
    approval: {
      status: "approved",
      approved_by: "product-owner",
      approved_at: "2026-08-25T04:00:00.000Z",
      method: "local",
    },
    ...overrides,
  };
  if (value.approval.status === "approved" && !value.approval.content_sha256)
    value.approval.content_sha256 = approvalDigest(value);
  return value;
}

describe("trust authority", () => {
  it("never trusts evidence without a verified behavior claim", () => {
    const approvalOnly: Evidence[] = [
      {
        id: "change-contract-approval",
        category: "plan",
        status: "verified",
        summary: "approved",
      },
    ];
    expect(computeVerdict(approvalOnly)).toBe("insufficient_evidence");
  });

  it("rejects unknown surfaces, missing evidence, and future approval", () => {
    const review = reviewContract(
      contract({
        affected_surfaces: ["unknown"],
        required_evidence: [],
        approval: {
          status: "approved",
          approved_by: "product-owner",
          approved_at: "2026-08-25T08:00:00.000Z",
        },
      }),
      config(),
      new Date("2026-08-25T05:00:00.000Z"),
    );
    expect(review.valid).toBe(false);
    expect(review.blockingIssues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("future"),
        expect.stringContaining("At least one evidence source"),
        expect.stringContaining("unknown"),
      ]),
    );
  });

  it("rejects cyclic surface dependency policy", () => {
    const result = trustConfigSchema.safeParse({
      version: 1,
      repository: { name: "cycle", root: "." },
      knowledge: { sources: [] },
      surfaces: [
        { id: "a", paths: ["a/**"], requires: [], risks: [], depends_on: ["b"] },
        { id: "b", paths: ["b/**"], requires: [], risks: [], depends_on: ["a"] },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "Surface dependency cycle: a -> b -> a.",
      );
  });

  it("verifies signed contract approval against repository authority", () => {
    const key = generateAuthorityKeyPair();
    const signedConfig = config();
    signedConfig.authority = {
      allow_local_approvals: false,
      require_signed_reports: false,
      trusted_approvers: [{ id: "product-owner", public_key_base64: key.publicKeyBase64 }],
    };
    const signedContract = contract({
      approval: {
        status: "approved",
        approved_by: "product-owner",
        approved_at: "2026-08-25T04:00:00.000Z",
        method: "ed25519",
        key_id: "product-owner",
      },
    });
    signedContract.approval.signature = signDigest(
      approvalSignatureDigest(signedContract),
      key.privateKeyPem,
    );
    expect(reviewContract(signedContract, signedConfig).valid).toBe(true);

    const expiredConfig = structuredClone(signedConfig);
    expiredConfig.authority!.trusted_approvers![0]!.not_after = "2026-08-25T03:00:00.000Z";
    expect(reviewContract(signedContract, expiredConfig).blockingIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("had expired")]),
    );

    const tampered = structuredClone(signedContract);
    tampered.intent = "A different intent after approval";
    expect(reviewContract(tampered, signedConfig).blockingIssues).toEqual(
      expect.arrayContaining([expect.stringContaining("changed after approval")]),
    );
  });

  it("binds a trusted verdict to verified claims and provenance", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-authority-"));
    temporaryDirectories.push(outputDirectory);
    const report = await verifyChange({
      config: config(),
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      changedFilesSource: "explicit",
      outputDirectory,
    });
    expect(report.verdict).toBe("trusted");
    expect(report.evidence).toContainEqual(
      expect.objectContaining({ id: "claim:behavior-works", status: "verified" }),
    );
    expect(report.provenance.digests.contract_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.provenance.digests.change_set_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.provenance.repository.changed_files_source).toBe("explicit");
  });

  it("rejects explicit change sets unless repository policy allows fixtures", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-explicit-change-"));
    temporaryDirectories.push(outputDirectory);
    const strictConfig = config();
    delete strictConfig.repository.allow_explicit_changed_files;
    const report = await verifyChange({
      config: strictConfig,
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      changedFilesSource: "explicit",
      outputDirectory,
    });
    expect(report.evidence).toContainEqual(
      expect.objectContaining({ id: "change-set-authority", status: "not_verified" }),
    );
    expect(report.verdict).toBe("insufficient_evidence");
  });

  it("does not execute shell-backed checks without explicit repository authorization", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-shell-policy-"));
    temporaryDirectories.push(outputDirectory);
    const hardenedConfig = config();
    hardenedConfig.execution = {
      allow_shell_commands: false,
      inherit_environment: false,
      max_attempts: 1,
      retry_backoff_ms: 250,
    };
    const report = await verifyChange({
      config: hardenedConfig,
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      outputDirectory,
    });
    expect(report.evidence).toContainEqual(
      expect.objectContaining({ id: "behavior-check", status: "not_verified" }),
    );
    expect(report.verdict).toBe("insufficient_evidence");
  });

  it("does not treat a zero-test command as verified behavior evidence", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-empty-tests-"));
    temporaryDirectories.push(outputDirectory);
    const emptyTestConfig = config();
    emptyTestConfig.execution!.allow_shell_commands = false;
    emptyTestConfig.checks = [
      {
        id: "behavior-check",
        kind: "test",
        executable: process.execPath,
        args: ["-e", "console.log('# tests 0')"],
        cwd: ".",
        env: {},
        scope: ["src/**"],
        tags: [],
        required: false,
        timeout_ms: 10_000,
      },
    ];
    const report = await verifyChange({
      config: emptyTestConfig,
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      changedFilesSource: "explicit",
      outputDirectory,
    });
    expect(report.evidence).toContainEqual(
      expect.objectContaining({
        id: "behavior-check",
        status: "not_verified",
        reason: expect.stringContaining("zero tests"),
      }),
    );
    expect(report.verdict).toBe("insufficient_evidence");
  });

  it("requires and verifies a trusted report attestation", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-attestation-"));
    temporaryDirectories.push(outputDirectory);
    const key = generateAuthorityKeyPair();
    const signedConfig = config();
    signedConfig.authority = {
      allow_local_approvals: true,
      require_signed_reports: true,
      trusted_reporters: [{ id: "ci", public_key_base64: key.publicKeyBase64 }],
    };
    const unsigned = await verifyChange({
      config: signedConfig,
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      outputDirectory: path.join(outputDirectory, "unsigned"),
    });
    expect(unsigned.verdict).toBe("insufficient_evidence");

    const signed = await verifyChange({
      config: signedConfig,
      contract: contract(),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      outputDirectory: path.join(outputDirectory, "signed"),
      reportSigner: { id: "ci", privateKeyPem: key.privateKeyPem },
    });
    expect(signed.verdict).toBe("trusted");
    expect(signed.attestation).toEqual(
      expect.objectContaining({ algorithm: "ed25519", signer_id: "ci" }),
    );
    expect(verifyReportAttestation(signed, signedConfig)).toBeNull();

    const revokedConfig = structuredClone(signedConfig);
    revokedConfig.authority!.trusted_reporters![0]!.revoked_at = new Date(
      Date.now() - 1_000,
    ).toISOString();
    revokedConfig.authority!.trusted_reporters![0]!.revocation_reason = "suspected compromise";
    expect(verifyReportAttestation(signed, revokedConfig)).toContain("was revoked");

    const tampered = structuredClone(signed);
    tampered.evidence[0]!.summary = "tampered evidence";
    expect(verifyReportAttestation(tampered, signedConfig)).toContain("changed after attestation");

    const consistentlySignedButInvalid = structuredClone(signed);
    delete consistentlySignedButInvalid.attestation;
    consistentlySignedButInvalid.plan.selected_checks = [];
    consistentlySignedButInvalid.provenance.digests.plan_sha256 = sha256(
      consistentlySignedButInvalid.plan,
    );
    consistentlySignedButInvalid.attestation = createReportAttestation(
      consistentlySignedButInvalid,
      "ci",
      key.privateKeyPem,
    );
    expect(verifyReportAttestation(consistentlySignedButInvalid, signedConfig)).toBeNull();
    expect(validateReportSemantics(consistentlySignedButInvalid, signedConfig)).toEqual(
      expect.arrayContaining([expect.stringContaining("plan does not match")]),
    );
  });

  it("binds claims to specific verifier results", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-claim-result-"));
    temporaryDirectories.push(outputDirectory);
    const resultConfig = trustConfigSchema.parse({
      version: 1,
      repository: { name: "result-fixture", root: "." },
      knowledge: { sources: [] },
      authority: { allow_local_approvals: true, require_signed_reports: false },
      execution: { allow_shell_commands: true, inherit_environment: false },
      surfaces: [
        {
          id: "app",
          paths: ["src/**"],
          requires: ["journeys"],
          risks: [],
          depends_on: [],
        },
      ],
      verifiers: [
        {
          id: "journeys",
          kind: "cli",
          scope: ["src/**"],
          tags: [],
          missions: [
            {
              id: "good",
              executable: process.execPath,
              args: ["-e", "process.exit(0)"],
            },
            {
              id: "bad",
              executable: process.execPath,
              args: ["-e", "process.exit(1)"],
            },
          ],
        },
      ],
    });
    const report = await verifyChange({
      config: resultConfig,
      contract: contract({
        expected_behaviors: [
          { id: "good", description: "good journey works", evidence: ["journeys#good"] },
          { id: "bad", description: "bad journey works", evidence: ["journeys#bad"] },
        ],
        required_evidence: ["journeys"],
      }),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      outputDirectory,
    });
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claim:good", status: "verified" }),
        expect.objectContaining({ id: "claim:bad", status: "failed" }),
      ]),
    );
    expect(report.verdict).toBe("not_trusted");
  });

  it("keeps a retried failure attached to a result-specific claim", async () => {
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-retried-claim-"));
    temporaryDirectories.push(outputDirectory);
    const marker = path.join(outputDirectory, "attempt.txt");
    const resultConfig = trustConfigSchema.parse({
      version: 1,
      repository: {
        name: "retried-result-fixture",
        root: ".",
        allow_explicit_changed_files: true,
      },
      knowledge: { sources: [] },
      authority: { allow_local_approvals: true, require_signed_reports: false },
      execution: {
        allow_shell_commands: false,
        inherit_environment: false,
        max_attempts: 2,
        retry_backoff_ms: 0,
      },
      surfaces: [
        {
          id: "app",
          paths: ["src/**"],
          requires: ["journeys"],
          risks: [],
          depends_on: [],
        },
      ],
      verifiers: [
        {
          id: "journeys",
          kind: "cli",
          scope: ["src/**"],
          tags: [],
          missions: [
            {
              id: "flaky",
              executable: process.execPath,
              args: [
                "-e",
                "const fs=require('fs'); const p=process.argv[1]; if(fs.existsSync(p)) process.exit(0); fs.writeFileSync(p,'failed once'); process.exit(1)",
                marker,
              ],
            },
          ],
        },
      ],
    });
    const report = await verifyChange({
      config: resultConfig,
      contract: contract({
        expected_behaviors: [
          {
            id: "flaky",
            description: "the retried journey is stable",
            evidence: ["journeys#flaky"],
          },
        ],
        required_evidence: ["journeys"],
      }),
      repositoryRoot: process.cwd(),
      changedFiles: ["src/behavior.ts"],
      outputDirectory,
    });
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "journeys:flaky:attempt-1", status: "failed" }),
        expect.objectContaining({ id: "journeys:flaky", status: "verified" }),
        expect.objectContaining({ id: "claim:flaky", status: "failed" }),
      ]),
    );
    expect(report.verdict).toBe("not_trusted");
  });

  it("attests the initial snapshot and fails when evidence mutates it", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-moving-snapshot-"));
    temporaryDirectories.push(directory);
    await mkdir(path.join(directory, "src"), { recursive: true });
    const changedFile = path.join(directory, "src", "behavior.ts");
    await writeFile(changedFile, "export const value = 'initial';\n", "utf8");
    const initialDigest = await changeSetDigest(directory, ["src/behavior.ts"]);
    const mutatingConfig = trustConfigSchema.parse({
      version: 1,
      repository: {
        name: "moving-snapshot",
        root: ".",
        allow_explicit_changed_files: true,
      },
      knowledge: { sources: [] },
      authority: { allow_local_approvals: true, require_signed_reports: false },
      surfaces: [
        {
          id: "app",
          paths: ["src/**"],
          requires: ["mutator"],
          risks: [],
          depends_on: [],
        },
      ],
      verifiers: [
        {
          id: "mutator",
          kind: "cli",
          scope: ["src/**"],
          tags: [],
          missions: [
            {
              id: "write",
              executable: process.execPath,
              args: [
                "-e",
                "require('fs').writeFileSync(process.argv[1],\"export const value = 'mutated';\\n\")",
                changedFile,
              ],
            },
          ],
        },
      ],
    });
    const report = await verifyChange({
      config: mutatingConfig,
      contract: contract({
        expected_behaviors: [
          { id: "mutation", description: "the mission ran", evidence: ["mutator#write"] },
        ],
        required_evidence: ["mutator"],
      }),
      repositoryRoot: directory,
      changedFiles: ["src/behavior.ts"],
      changedFilesSource: "explicit",
      outputDirectory: path.join(directory, "report"),
    });
    expect(report.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mutator:write", status: "verified" }),
        expect.objectContaining({ id: "change-set-stability", status: "failed" }),
      ]),
    );
    expect(report.provenance.digests.change_set_sha256).toBe(initialDigest);
    expect(report.verdict).toBe("not_trusted");
  });

  it("hashes a symlink object without following it outside the repository", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-symlink-snapshot-"));
    temporaryDirectories.push(directory);
    const external = await mkdtemp(path.join(os.tmpdir(), "trust-external-"));
    temporaryDirectories.push(external);
    const externalFile = path.join(external, "secret.txt");
    await writeFile(externalFile, "first secret", "utf8");
    await symlink(externalFile, path.join(directory, "linked.txt"));
    const before = await changeSetDigest(directory, ["linked.txt"]);
    await writeFile(externalFile, "different secret", "utf8");
    expect(await changeSetDigest(directory, ["linked.txt"])).toBe(before);
    expect(() => validateChangedFiles(directory, ["../secret.txt"])).toThrow(
      "canonical repository-relative path",
    );
  });
});
