import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTrustConfig, loadTrustReport } from "../packages/core/src/files.js";
import { runProcess } from "../packages/runner/src/index.js";

const cli = path.resolve("packages/cli/src/index.ts");

function stripAnsi(value: string) {
  return value
    .split(String.fromCharCode(27))
    .map((part, index) => (index === 0 ? part : part.replace(/^\[[0-?]*[ -/]*[@-~]/, "")))
    .join("");
}

async function trust(args: string[]) {
  const result = await runProcess({
    executable: process.execPath,
    args: ["--import", "tsx", cli, ...args],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
  return {
    ...result,
    stdout: stripAnsi(result.stdout),
    stderr: stripAnsi(result.stderr),
  };
}

async function git(repository: string, args: string[]) {
  const result = await runProcess({
    executable: "git",
    args,
    cwd: repository,
    timeoutMs: 10_000,
    inheritEnv: false,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr);
}

describe("ridiculously easy onboarding", () => {
  it("goes from one intent sentence to a local verdict and GitHub enforcement", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-start-"));
    try {
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({ name: "starter", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(repository, "feature.js"), "export const enabled = false;\n");
      await writeFile(
        path.join(repository, "feature.test.js"),
        [
          'import assert from "node:assert/strict";',
          'import test from "node:test";',
          'import { enabled } from "./feature.js";',
          "",
          'test("the feature is enabled", () => assert.equal(enabled, true));',
          "",
        ].join("\n"),
        "utf8",
      );
      await git(repository, ["init", "--initial-branch=main"]);
      await git(repository, ["config", "user.email", "trust@example.invalid"]);
      await git(repository, ["config", "user.name", "Trust Fixture"]);
      await git(repository, ["add", "package.json", "feature.js", "feature.test.js"]);
      await git(repository, ["commit", "-m", "baseline"]);
      await writeFile(path.join(repository, "feature.js"), "export const enabled = true;\n");

      const initialStatus = await trust(["status", repository, "--format", "json"]);
      expect(initialStatus.exitCode, initialStatus.stderr).toBe(0);
      expect(JSON.parse(initialStatus.stdout)).toMatchObject({
        version: 1,
        setup: { policy: null, policy_mode: "none" },
        next: { action: "start" },
      });

      const started = await trust([
        "start",
        repository,
        "--intent",
        "Users can enable the feature safely",
      ]);
      expect(started.exitCode, started.stderr).toBe(0);
      expect(started.stdout).toContain("TRUSTED · LOCAL ASSURANCE");
      expect(started.stdout).toContain("1/1 behaviors established");

      const config = await loadTrustConfig(path.join(repository, "trust.yaml"));
      expect(config.checks).toEqual([
        expect.objectContaining({
          id: "test",
          executable: "npm",
          args: ["run", "test"],
        }),
      ]);
      expect(config.execution?.allow_shell_commands).toBe(false);
      const report = await loadTrustReport(
        path.join(repository, ".trust", "runs", "latest", "report.json"),
      );
      expect(report).toMatchObject({ verdict: "trusted", assurance: { level: "local" } });
      expect(report.plan.changed_files).toEqual(["feature.js"]);
      expect(await readFile(path.join(repository, ".trust", ".gitignore"), "utf8")).toBe(
        "runs/\nkeys/*.private.pem\n",
      );

      const localStatus = await trust(["status", repository, "--format", "json"]);
      expect(localStatus.exitCode, localStatus.stderr).toBe(0);
      expect(JSON.parse(localStatus.stdout)).toMatchObject({
        setup: { policy_mode: "local" },
        latest_run: { verdict: "trusted", assurance: "local" },
        next: { action: "enable_github" },
      });

      const inspected = await trust([
        "inspect",
        repository,
        "--config",
        path.join(repository, "trust.yaml"),
        "--format",
        "json",
      ]);
      expect(inspected.exitCode, inspected.stderr).toBe(0);
      expect(JSON.parse(inspected.stdout)).toMatchObject({
        version: 1,
        discovery: { name: "starter", packageManager: "npm" },
        graph: [expect.objectContaining({ surface: "repository", evidence: ["test"] })],
      });

      const planned = await trust([
        "plan",
        path.join(repository, ".trust", "contracts", "current.yaml"),
        "--config",
        path.join(repository, "trust.yaml"),
        "--format",
        "json",
        "--no-write",
      ]);
      expect(planned.exitCode, planned.stderr).toBe(0);
      expect(JSON.parse(planned.stdout)).toMatchObject({
        version: 1,
        valid: true,
        plan: { selected_checks: ["test"] },
        output: null,
      });

      const repeated = await trust([
        "start",
        repository,
        "--intent",
        "Users can enable the feature safely",
        "--format",
        "json",
      ]);
      expect(repeated.exitCode, repeated.stderr).toBe(0);
      expect(JSON.parse(repeated.stdout)).toMatchObject({
        version: 1,
        status: "completed",
        created_policy: false,
        report: { verdict: "trusted", assurance: { level: "local" } },
      });
      const repeatedReport = await loadTrustReport(
        path.join(repository, ".trust", "runs", "latest", "report.json"),
      );
      expect(repeatedReport.plan.changed_files).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/^\.trust\/runs\//)]),
      );
      const verifiedReport = await trust([
        "report:verify",
        path.join(repository, ".trust", "runs", "latest", "report.json"),
        "--config",
        path.join(repository, "trust.yaml"),
        "--require-trusted",
      ]);
      expect(verifiedReport.exitCode, verifiedReport.stdout + verifiedReport.stderr).toBe(0);
      expect(verifiedReport.stdout).toContain("Report integrity and authority are valid");

      const explained = await trust([
        "explain",
        "test",
        "--report",
        path.join(repository, ".trust", "runs", "latest", "report.json"),
      ]);
      expect(explained.exitCode, explained.stderr).toBe(0);
      expect(explained.stdout).toContain("TRUST EXPLAIN — test");
      expect(explained.stdout).toContain("Command: npm run test");

      const explainedJson = await trust([
        "explain",
        "test",
        "--report",
        path.join(repository, ".trust", "runs", "latest", "report.json"),
        "--format",
        "json",
      ]);
      expect(explainedJson.exitCode, explainedJson.stderr).toBe(0);
      expect(JSON.parse(explainedJson.stdout)).toMatchObject({
        version: 1,
        query: "test",
        evidence: [expect.objectContaining({ source_id: "test", status: "verified" })],
      });

      const verifiedJson = await trust([
        "verify",
        "--config",
        path.join(repository, "trust.yaml"),
        "--contract",
        path.join(repository, ".trust", "contracts", "current.yaml"),
        "--output",
        path.join(repository, ".trust", "runs", "automation"),
        "--format",
        "json",
        "--no-ci-output",
      ]);
      expect(verifiedJson.exitCode, verifiedJson.stderr).toBe(0);
      expect(JSON.parse(verifiedJson.stdout)).toMatchObject({
        verdict: "trusted",
        assurance: { level: "local" },
      });

      const localDoctor = await trust([
        "doctor",
        "--config",
        path.join(repository, "trust.yaml"),
        "--format",
        "json",
      ]);
      expect(localDoctor.exitCode, localDoctor.stderr).toBe(0);
      expect(JSON.parse(localDoctor.stdout)).toMatchObject({
        required_level: "local",
        ready: true,
        readiness: { trial: true, local: true, attested: false },
      });

      const enabled = await trust([
        "enable",
        "github",
        "--config",
        path.join(repository, "trust.yaml"),
      ]);
      expect(enabled.exitCode, enabled.stderr).toBe(0);
      expect(enabled.stdout).toContain("GitHub merge enforcement is ready locally");
      expect(enabled.stdout).toContain("executable-trust-layer@0.1.0 (must be available");
      expect(enabled.stdout).toContain("Trust authority / attest");
      const workflow = await readFile(
        path.join(repository, ".github", "workflows", "trust.yml"),
        "utf8",
      );
      expect(workflow).toContain("trust doctor --config trust.yaml");
      expect(workflow).toContain("--require attested");

      const attestedDoctor = await trust([
        "doctor",
        "--config",
        path.join(repository, "trust.yaml"),
        "--contract",
        path.join(repository, ".trust", "contracts", "current.yaml"),
        "--require",
        "attested",
        "--format",
        "json",
      ]);
      expect(attestedDoctor.exitCode, attestedDoctor.stderr).toBe(0);
      expect(JSON.parse(attestedDoctor.stdout)).toMatchObject({
        required_level: "attested",
        ready: true,
        readiness: { trial: true, local: true, attested: true },
      });

      const enforcedStatus = await trust(["status", repository, "--format", "json"]);
      expect(enforcedStatus.exitCode, enforcedStatus.stderr).toBe(0);
      expect(JSON.parse(enforcedStatus.stdout)).toMatchObject({
        setup: { policy_mode: "attested", github_workflow: expect.any(String) },
        next: { action: "check_attested_readiness" },
      });

      const refusedDowngrade = await trust([
        "start",
        repository,
        "--intent",
        "Users can enable the feature safely",
      ]);
      expect(refusedDowngrade.exitCode).toBe(1);
      expect(refusedDowngrade.stderr).toContain("requires enforced authority");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }, 60_000);

  it("creates reusable policy on a clean repository without verifying its own artifacts", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-clean-start-"));
    try {
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({ name: "clean-starter", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
        "utf8",
      );
      await writeFile(path.join(repository, "feature.js"), "export const enabled = false;\n");
      await writeFile(
        path.join(repository, "feature.test.js"),
        [
          'import assert from "node:assert/strict";',
          'import test from "node:test";',
          'import { enabled } from "./feature.js";',
          "",
          'test("the feature is enabled", () => assert.equal(enabled, true));',
          "",
        ].join("\n"),
        "utf8",
      );
      await git(repository, ["init", "--initial-branch=main"]);
      await git(repository, ["config", "user.email", "trust@example.invalid"]);
      await git(repository, ["config", "user.name", "Trust Fixture"]);
      await git(repository, ["add", "package.json", "feature.js", "feature.test.js"]);
      await git(repository, ["commit", "-m", "baseline"]);

      const clean = await trust([
        "start",
        repository,
        "--intent",
        "Users can enable the feature safely",
        "--format",
        "json",
      ]);
      expect(clean.exitCode, clean.stderr).toBe(0);
      expect(JSON.parse(clean.stdout)).toMatchObject({
        version: 1,
        status: "no_changes",
        created_policy: true,
        change_set: [],
        next: { reason: "No Git changes are currently available to verify." },
      });
      expect(await readFile(path.join(repository, "trust.yaml"), "utf8")).toContain(
        "allow_local_approvals: true",
      );

      await writeFile(path.join(repository, "feature.js"), "export const enabled = true;\n");
      const started = await trust([
        "start",
        repository,
        "--intent",
        "Users can enable the feature safely",
      ]);
      expect(started.exitCode, started.stderr).toBe(0);
      expect(started.stdout).toContain("Using safe local policy");
      expect(started.stdout).toContain("TRUSTED · LOCAL ASSURANCE");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("explains that guided start needs an initialized Git history", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-no-git-"));
    try {
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({ name: "no-git", scripts: { test: "node --test" } })}\n`,
        "utf8",
      );
      const result = await trust(["start", repository, "--intent", "Users can start safely"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("requires a Git repository with an initial commit");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("renders the bundled proof without repository setup", async () => {
    const result = await trust(["try"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("BROKEN · NOT TRUSTED");
    expect(result.stdout).toContain("FIXED · TRUSTED");
  });
});
