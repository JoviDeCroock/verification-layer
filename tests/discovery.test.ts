import { describe, expect, it } from "vitest";
import { discoverRepository } from "../packages/discovery/src/index.js";

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
  });
});
