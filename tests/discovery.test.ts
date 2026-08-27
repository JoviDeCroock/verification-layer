import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

  it("prefers one repository-owned project gate over duplicated generic evidence", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-project-gate-"));
    try {
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({
          name: "project-gate-fixture",
          scripts: {
            check: "npm run lint && npm test && npm run test:e2e",
            lint: "eslint .",
            test: "vitest run",
            "test:e2e": "playwright test",
          },
          devDependencies: { "@playwright/test": "1.0.0", vitest: "1.0.0" },
        })}\n`,
      );
      await writeFile(path.join(repository, "playwright.config.ts"), "export default {};\n");

      const report = await discoverRepository(repository);

      expect(report.config.checks).toEqual([
        expect.objectContaining({
          id: "project-gate",
          kind: "custom",
          executable: "npm",
          args: ["run", "check"],
        }),
      ]);
      expect(report.config.verifiers).toEqual([]);
      expect(report.config.surfaces[0]?.requires).toEqual(["project-gate"]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("recognizes docs/decisions ADRs and excludes nested Git repositories", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "trust-discovery-boundary-"));
    try {
      await mkdir(path.join(repository, "docs", "decisions"), { recursive: true });
      await mkdir(path.join(repository, "vendor", "nested", ".git"), { recursive: true });
      await writeFile(
        path.join(repository, "package.json"),
        `${JSON.stringify({ name: "boundary-fixture", scripts: { test: "node --test" } })}\n`,
      );
      await writeFile(path.join(repository, "docs", "decisions", "0001-boundary.md"), "# ADR\n");
      await writeFile(path.join(repository, "index.js"), "export {};\n");
      await writeFile(path.join(repository, "root.test.js"), "// root test\n");
      await writeFile(path.join(repository, "vendor", "nested", "index.js"), "export {};\n");
      await writeFile(path.join(repository, "vendor", "nested", "nested.test.js"), "// nested\n");
      await writeFile(
        path.join(repository, "vendor", "nested", "vitest.config.js"),
        "export {};\n",
      );

      const report = await discoverRepository(repository);

      expect(report.found).toContainEqual({ label: "1 ADR" });
      expect(report.potentialGaps).not.toContain("No architecture decision records were found.");
      expect(report.found).not.toContainEqual(expect.objectContaining({ label: "Vitest" }));
      expect(report.entryPoints).toEqual(["index.js"]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
