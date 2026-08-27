import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTrustConfig } from "../src/core/files.js";
import { runProcess } from "../src/runner/index.js";

async function setup(repository: string) {
  return runProcess({
    executable: process.execPath,
    args: [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "setup",
      repository,
      "--approver",
      "owner",
      "--reporter",
      "automation",
      "--valid-days",
      "30",
    ],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
}

async function doctor(repository: string) {
  return runProcess({
    executable: process.execPath,
    args: [
      "--import",
      "tsx",
      "src/cli/index.ts",
      "doctor",
      "--config",
      path.join(repository, "trust.yaml"),
      "--format",
      "json",
    ],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
}

describe("first-run setup", () => {
  it("creates strict, separate, expiring authority without overwriting", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-setup-"));
    try {
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({ name: "setup-fixture", scripts: { test: "node --test" } }, null, 2)}\n`,
        "utf8",
      );
      const first = await setup(repository);
      expect(first.exitCode, first.stderr).toBe(0);
      const config = await loadTrustConfig(path.join(repository, "trust.yaml"));
      expect(config.authority).toEqual(
        expect.objectContaining({
          allow_local_approvals: false,
          require_signed_reports: true,
        }),
      );
      expect(config.authority?.trusted_approvers?.[0]).toEqual(
        expect.objectContaining({
          id: "owner",
          not_before: expect.any(String),
          not_after: expect.any(String),
        }),
      );
      expect(config.authority?.trusted_reporters?.[0]).toEqual(
        expect.objectContaining({
          id: "automation",
          not_before: expect.any(String),
          not_after: expect.any(String),
        }),
      );
      expect(config.authority?.trusted_approvers?.[0]?.public_key_base64).not.toBe(
        config.authority?.trusted_reporters?.[0]?.public_key_base64,
      );
      const keyDirectory = path.join(repository, ".trust", "keys");
      expect((await stat(path.join(keyDirectory, "approver.private.pem"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(path.join(keyDirectory, "reporter.private.pem"))).mode & 0o777).toBe(
        0o600,
      );
      const readiness = await doctor(repository);
      expect(readiness.exitCode).toBe(0);
      expect(JSON.parse(readiness.stdout)).toEqual(
        expect.objectContaining({
          required_level: "local",
          ready: true,
          readiness: { trial: true, local: true, attested: true },
          problems: [],
          warnings: expect.arrayContaining([
            expect.stringContaining("repository-wide starter surface"),
          ]),
        }),
      );
      const originalPolicy = await readFile(path.join(repository, "trust.yaml"), "utf8");
      const second = await setup(repository);
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain("Refusing to overwrite");
      expect(await readFile(path.join(repository, "trust.yaml"), "utf8")).toBe(originalPolicy);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects an empty policy even when authority identities are ready", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-setup-empty-"));
    try {
      const first = await setup(repository);
      expect(first.exitCode, first.stderr).toBe(0);
      const readiness = await doctor(repository);
      expect(readiness.exitCode).toBe(1);
      expect(JSON.parse(readiness.stdout)).toEqual(
        expect.objectContaining({
          ready: false,
          required_level: "local",
          readiness: { trial: true, local: false, attested: false },
          counts: expect.objectContaining({ checks: 0, invariants: 0, verifiers: 0, surfaces: 0 }),
          problems: expect.arrayContaining([
            expect.stringContaining("no checks, invariants, or verifiers"),
            expect.stringContaining("no product surfaces"),
          ]),
        }),
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
