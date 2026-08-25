import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../packages/runner/src/index.js";

async function trust(args: string[]) {
  return runProcess({
    executable: process.execPath,
    args: ["--import", "tsx", "packages/cli/src/index.ts", ...args],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
}

describe("human and agent CLI experience", () => {
  it("orients users before presenting grouped expert commands", async () => {
    const help = await trust(["--help"]);
    expect(help.exitCode, help.stderr).toBe(0);
    expect(help.stdout.indexOf("Start here:")).toBeLessThan(help.stdout.indexOf("Core workflow:"));
    expect(help.stdout).toContain("trust status    See current state");
    expect(help.stdout).toContain("Policy and contracts:");
    expect(help.stdout).toContain("Authority and CI:");
    expect(help.stdout).toContain("Reports and learning:");
    expect(help.stdout).toContain("Automation: add --format json to start, status");

    const commandHelp = await trust(["start", "--help"]);
    expect(commandHelp.exitCode, commandHelp.stderr).toBe(0);
    expect(commandHelp.stdout).toContain("--intent <text>");
    expect(commandHelp.stdout).not.toContain("Start here:");
  });

  it("turns missing-file failures into a recovery-oriented message", async () => {
    const result = await trust(["doctor", "--config", "/tmp/trust-file-that-does-not-exist"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Required file not found");
    expect(result.stderr).toContain("Run trust status for the recommended setup step");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("fails unknown commands with a useful suggestion", async () => {
    const result = await trust(["stats"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command "stats"');
    expect(result.stderr).toContain('Did you mean "status"?');
    expect(result.stderr).toContain("trust --help");
  });

  it("keeps status machine-readable when policy data needs repair", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-invalid-policy-"));
    const policy = path.join(directory, "trust.yaml");
    try {
      await writeFile(policy, "version: 1\nrepository: invalid\n", "utf8");
      const result = await trust(["status", ".", "--config", policy, "--format", "json"]);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        setup: { policy: policy, policy_mode: "none" },
        problems: [expect.stringContaining("Trust data is invalid")],
        next: { action: "repair_policy", command: "trust schema:export .trust/schemas" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("never recommends staging an unreviewed directory to initialize provenance", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-git-orientation-"));
    try {
      const absent = await trust(["status", directory, "--format", "json"]);
      expect(absent.exitCode, absent.stderr).toBe(0);
      expect(JSON.parse(absent.stdout)).toMatchObject({
        repository: { git: { initialized: false, head_sha: null } },
        next: { action: "initialize_git", command: "git init" },
      });
      expect(absent.stdout).not.toContain("git add .");

      const initialized = await runProcess({
        executable: "git",
        args: ["init", "--initial-branch=main"],
        cwd: directory,
        timeoutMs: 10_000,
        inheritEnv: false,
      });
      expect(initialized.exitCode, initialized.stderr).toBe(0);
      const noCommit = await trust(["status", directory, "--format", "json"]);
      expect(noCommit.exitCode, noCommit.stderr).toBe(0);
      expect(JSON.parse(noCommit.stdout)).toMatchObject({
        repository: { git: { initialized: true, head_sha: null } },
        next: { action: "create_initial_commit", command: "git status --short" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
