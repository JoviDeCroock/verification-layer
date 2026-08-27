import { describe, expect, it } from "vitest";
import { discoverRepository } from "../src/discovery/index.js";

describe("production policy discovery", () => {
  it("generates fail-closed authority and execution defaults", async () => {
    const report = await discoverRepository("examples/demo-app");
    expect(report.config.repository.allow_explicit_changed_files).toBe(false);
    expect(report.config.authority).toEqual(
      expect.objectContaining({
        allow_local_approvals: false,
        require_signed_reports: true,
        trusted_approvers: [],
        trusted_reporters: [],
      }),
    );
    expect(report.config.execution).toEqual({
      allow_shell_commands: false,
      inherit_environment: false,
      max_attempts: 1,
      retry_backoff_ms: 250,
    });
    expect(report.config.surfaces).toEqual([
      expect.objectContaining({
        id: "repository",
        paths: ["**/*"],
        requires: expect.arrayContaining(["typecheck", "test", "build", "playwright"]),
      }),
    ]);
    expect(report.potentialGaps).toEqual(
      expect.arrayContaining([expect.stringContaining("repository-wide starter surface")]),
    );
  });

  it("does not promote a nested example Playwright config into a root verifier", async () => {
    const report = await discoverRepository(".");

    expect(report.found).toContainEqual({ label: "Playwright" });
    expect(report.config.verifiers).not.toContainEqual(
      expect.objectContaining({ id: "playwright" }),
    );
    expect(report.config.surfaces).toHaveLength(1);
    expect(report.config.surfaces[0]).toMatchObject({ id: "repository" });
    expect(report.config.surfaces[0]?.requires).not.toContain("playwright");
    expect(report.potentialGaps).toContain("No E2E command was detected.");
  });
});
