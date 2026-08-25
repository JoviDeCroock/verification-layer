import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { runProcess } from "../packages/runner/src/index.js";
import { trustConfigSchema } from "../packages/core/src/index.js";
import { sha256 } from "../packages/core/src/provenance.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function trust(args: string[], env?: Record<string, string>) {
  return runProcess({
    executable: process.execPath,
    args: ["--import", "tsx", "packages/cli/src/index.ts", ...args],
    cwd: process.cwd(),
    timeoutMs: 30_000,
    ...(env ? { env } : {}),
  });
}

describe("authority CLI", () => {
  it("previews report retention before deleting recognized runs", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-retention-"));
    temporaryDirectories.push(directory);
    const run = path.join(directory, "old-run");
    const unrelated = path.join(directory, "unrelated");
    await mkdir(run, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(path.join(run, "report.json"), "{}\n", "utf8");

    const preview = await trust(["reports:prune", directory, "--keep", "0"]);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Would prune 1 report");
    expect((await stat(run)).isDirectory()).toBe(true);

    const confirmed = await trust(["reports:prune", directory, "--keep", "0", "--confirm"]);
    expect(confirmed.exitCode).toBe(0);
    await expect(stat(run)).rejects.toThrow();
    expect((await stat(unrelated)).isDirectory()).toBe(true);
  });

  it("creates identities and produces an independently verifiable signed report", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-cli-authority-"));
    temporaryDirectories.push(directory);
    const configFile = path.join(directory, "trust.yaml");
    const contractFile = path.join(directory, "change-contract.yaml");
    const keyPrefix = path.join(directory, "authority");
    const signerFile = path.join(directory, "external-signer.mjs");
    const invalidSignerFile = path.join(directory, "invalid-signer.mjs");
    const workflowFile = path.join(directory, "trust.yml");
    const outputDirectory = path.join(directory, "run");
    await writeFile(
      configFile,
      YAML.stringify({
        version: 1,
        repository: {
          name: "cli-authority-fixture",
          root: process.cwd(),
          allow_explicit_changed_files: true,
        },
        knowledge: { sources: [] },
        authority: {
          allow_local_approvals: false,
          require_signed_reports: true,
          trusted_approvers: [],
          trusted_reporters: [],
        },
        execution: { allow_shell_commands: true, inherit_environment: true },
        checks: [
          {
            id: "behavior-check",
            kind: "test",
            command: `${process.execPath} -e "process.exit(process.env.TRUST_REPORT_PRIVATE_KEY ? 1 : 0)"`,
            scope: ["package.json"],
            tags: [],
          },
        ],
        surfaces: [
          {
            id: "application",
            paths: ["package.json"],
            requires: ["behavior-check"],
            risks: [],
            depends_on: [],
          },
        ],
      }),
      "utf8",
    );
    await writeFile(
      signerFile,
      [
        'import { sign } from "node:crypto";',
        'let input = "";',
        "for await (const chunk of process.stdin) input += chunk;",
        "const request = JSON.parse(input);",
        'const signature = sign(null, Buffer.from(request.signing_digest, "hex"), process.env.TEST_EXTERNAL_SIGNER_KEY).toString("base64");',
        "process.stdout.write(JSON.stringify({ signature }));",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      invalidSignerFile,
      'process.stdout.write(JSON.stringify({ signature: "forged" }));\n',
      "utf8",
    );

    const commands = [
      ["authority:keygen", keyPrefix, "--id", "product-owner"],
      [
        "authority:register",
        `${keyPrefix}.public.txt`,
        "--config",
        configFile,
        "--id",
        "product-owner",
        "--role",
        "approver",
      ],
      [
        "authority:register",
        `${keyPrefix}.public.txt`,
        "--config",
        configFile,
        "--id",
        "ci",
        "--role",
        "reporter",
      ],
      [
        "contract:init",
        contractFile,
        "--config",
        configFile,
        "--id",
        "signed-change",
        "--intent",
        "Prove signed authority",
        "--surface",
        "application",
      ],
      [
        "contract:approve",
        contractFile,
        "--config",
        configFile,
        "--by",
        "product-owner",
        "--key",
        `${keyPrefix}.private.pem`,
      ],
      ["doctor", "--config", configFile, "--contract", contractFile],
      [
        "ci:init",
        workflowFile,
        "--config",
        configFile,
        "--contract",
        contractFile,
        "--report-signer",
        "ci",
        "--authority-package",
        "executable-trust-layer@0.1.0",
      ],
    ];
    for (const args of commands) {
      const result = await trust(args);
      expect(result.exitCode, `${args[0]} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    }
    expect((await stat(`${keyPrefix}.private.pem`)).mode & 0o777).toBe(0o600);
    expect(await readFile(workflowFile, "utf8")).toContain(
      "ref: ${{ github.event.pull_request.head.sha }}",
    );
    const doctorJson = await trust([
      "doctor",
      "--config",
      configFile,
      "--contract",
      contractFile,
      "--format",
      "json",
    ]);
    expect(doctorJson.exitCode).toBe(0);
    expect(JSON.parse(doctorJson.stdout)).toEqual(
      expect.objectContaining({ ready: true, repository: "cli-authority-fixture" }),
    );

    const unsigned = await trust([
      "verify",
      "--config",
      configFile,
      "--contract",
      contractFile,
      "--changed",
      "package.json",
      "--output",
      outputDirectory,
    ]);
    expect(unsigned.exitCode).toBe(1);
    expect(unsigned.stdout).toContain("INSUFFICIENT EVIDENCE");
    const policyDigest = sha256(
      trustConfigSchema.parse(YAML.parse(await readFile(configFile, "utf8"))),
    );
    const printedPolicyDigest = await trust(["policy:digest", "--config", configFile]);
    expect(printedPolicyDigest.exitCode).toBe(0);
    expect(printedPolicyDigest.stdout.trim()).toBe(policyDigest);
    const externallyAttested = await trust(
      [
        "report:attest",
        path.join(outputDirectory, "report.json"),
        "--config",
        configFile,
        "--signer",
        "ci",
        "--signer-executable",
        process.execPath,
        "--signer-arg",
        signerFile,
        "--signer-env",
        "TEST_EXTERNAL_SIGNER_KEY",
        "--expected-policy-sha256",
        policyDigest,
        "--require-trusted",
      ],
      { TEST_EXTERNAL_SIGNER_KEY: await readFile(`${keyPrefix}.private.pem`, "utf8") },
    );
    expect(
      externallyAttested.exitCode,
      `external signer failed:\n${externallyAttested.stdout}\n${externallyAttested.stderr}`,
    ).toBe(0);
    for (const args of [
      [
        "report:verify",
        path.join(outputDirectory, "report.json"),
        "--config",
        configFile,
        "--expected-policy-sha256",
        policyDigest,
        "--require-trusted",
      ],
    ]) {
      const result = await trust(args);
      expect(result.exitCode, `${args[0]} failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    }

    const forgedDirectory = path.join(directory, "forged");
    const forgedUnsigned = await trust([
      "verify",
      "--config",
      configFile,
      "--contract",
      contractFile,
      "--changed",
      "package.json",
      "--output",
      forgedDirectory,
    ]);
    expect(forgedUnsigned.exitCode).toBe(1);
    const forged = await trust([
      "report:attest",
      path.join(forgedDirectory, "report.json"),
      "--config",
      configFile,
      "--signer",
      "ci",
      "--signer-executable",
      process.execPath,
      "--signer-arg",
      invalidSignerFile,
    ]);
    expect(forged.exitCode).toBe(1);
    expect(forged.stderr).toContain("attestation signature is invalid");
    expect(
      JSON.parse(await readFile(path.join(forgedDirectory, "report.json"), "utf8")),
    ).not.toHaveProperty("attestation");

    const directlySignedDirectory = path.join(directory, "directly-signed");
    const directlySigned = await trust(
      [
        "verify",
        "--config",
        configFile,
        "--contract",
        contractFile,
        "--changed",
        "package.json",
        "--output",
        directlySignedDirectory,
        "--report-key-env",
        "TRUST_REPORT_PRIVATE_KEY",
        "--report-signer",
        "ci",
      ],
      { TRUST_REPORT_PRIVATE_KEY: await readFile(`${keyPrefix}.private.pem`, "utf8") },
    );
    expect(directlySigned.exitCode).toBe(0);
    const directlyVerified = await trust([
      "report:verify",
      path.join(directlySignedDirectory, "report.json"),
      "--config",
      configFile,
    ]);
    expect(directlyVerified.exitCode).toBe(0);
    const auditJournal = path.join(directory, "audit", "reports.jsonl");
    const audited = await trust([
      "audit:append",
      path.join(directlySignedDirectory, "report.json"),
      "--config",
      configFile,
      "--journal",
      auditJournal,
      "--expected-policy-sha256",
      policyDigest,
      "--expected-count",
      "0",
    ]);
    expect(audited.exitCode, audited.stderr).toBe(0);
    const auditHead = /^Head: ([a-f0-9]{64})$/m.exec(audited.stdout)?.[1];
    expect(auditHead).toBeTruthy();
    const auditVerified = await trust([
      "audit:verify",
      auditJournal,
      "--config",
      configFile,
      "--expected-head",
      auditHead!,
      "--expected-count",
      "1",
    ]);
    expect(auditVerified.exitCode, auditVerified.stdout).toBe(0);
    const duplicateAudit = await trust([
      "audit:append",
      path.join(directlySignedDirectory, "report.json"),
      "--config",
      configFile,
      "--journal",
      auditJournal,
    ]);
    expect(duplicateAudit.exitCode).toBe(1);
    expect(duplicateAudit.stderr).toContain("already present");
    const wrongTrustRoot = await trust([
      "report:verify",
      path.join(directlySignedDirectory, "report.json"),
      "--config",
      configFile,
      "--expected-policy-sha256",
      "0".repeat(64),
      "--require-trusted",
    ]);
    expect(
      wrongTrustRoot.exitCode,
      `wrong trust root unexpectedly passed:\n${wrongTrustRoot.stdout}\n${wrongTrustRoot.stderr}`,
    ).toBe(1);
    expect(wrongTrustRoot.stdout).toContain("expected trust-root digest");

    const report = JSON.parse(
      await readFile(path.join(directlySignedDirectory, "report.json"), "utf8"),
    ) as { verdict: string; attestation?: { signer_id?: string } };
    expect(report.verdict).toBe("trusted");
    expect(report.attestation?.signer_id).toBe("ci");

    const listed = await trust(["authority:list", "--config", configFile]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("reporter ci");
    expect(listed.stdout).toContain("active");
    const revoked = await trust([
      "authority:revoke",
      "ci",
      "--config",
      configFile,
      "--role",
      "reporter",
      "--reason",
      "rotation test",
    ]);
    expect(revoked.exitCode).toBe(0);
    const rejectedAfterRevocation = await trust([
      "report:verify",
      path.join(directlySignedDirectory, "report.json"),
      "--config",
      configFile,
    ]);
    expect(rejectedAfterRevocation.exitCode).toBe(1);
    expect(rejectedAfterRevocation.stdout).toContain("was revoked");
  }, 30_000);
});
