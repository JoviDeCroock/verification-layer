import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { trustConfigSchema, type VerificationPlan } from "../src/core/index.js";
import {
  runProcess,
  runProcessWithRetries,
  runSelectedChecks,
} from "../src/runner/index.js";

describe("evidence process lifecycle", () => {
  it("terminates a process group when verification is cancelled", async () => {
    const controller = new AbortController();
    const running = runProcess({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      timeoutMs: 10_000,
      inheritEnv: false,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 25);

    const result = await running;
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(130);
    expect(result.durationMs).toBeLessThan(2_500);
  });

  it("retains every bounded retry attempt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-retry-"));
    const marker = path.join(directory, "attempt.txt");
    try {
      const results = await runProcessWithRetries(
        {
          executable: process.execPath,
          args: [
            "-e",
            "const fs=require('fs'); const p=process.argv[1]; let n=0; try { n=Number(fs.readFileSync(p,'utf8')) } catch {} fs.writeFileSync(p,String(n+1)); process.exit(n === 0 ? 1 : 0)",
            marker,
          ],
          cwd: directory,
          timeoutMs: 2_000,
          inheritEnv: false,
        },
        3,
        1,
      );
      expect(results.map((result) => result.exitCode)).toEqual([1, 0]);
      expect(await readFile(marker, "utf8")).toBe("2");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("treats denied loopback binding as insufficient infrastructure evidence", async () => {
    const config = trustConfigSchema.parse({
      version: 1,
      repository: { name: "infrastructure-fixture", root: "." },
      knowledge: { sources: [] },
      execution: { allow_shell_commands: false, inherit_environment: false },
      checks: [
        {
          id: "server-test",
          kind: "test",
          executable: process.execPath,
          args: [
            "-e",
            "process.stderr.write('Error: listen EPERM: operation not permitted 127.0.0.1'); process.exit(1)",
          ],
          cwd: ".",
          env: {},
          scope: ["**/*"],
          tags: [],
        },
      ],
      surfaces: [
        {
          id: "repository",
          paths: ["**/*"],
          requires: ["server-test"],
          risks: [],
          depends_on: [],
        },
      ],
    });
    const plan: VerificationPlan = {
      version: 1,
      contract_id: "infrastructure-change",
      created_at: new Date().toISOString(),
      changed_files: ["src/server.ts"],
      affected_surfaces: ["repository"],
      selected_checks: ["server-test"],
      selected_invariants: [],
      selected_verifiers: [],
      qa_required: false,
      selection_reasons: {},
    };

    const evidence = await runSelectedChecks(config, plan, process.cwd());

    expect(evidence).toContainEqual(
      expect.objectContaining({
        id: "server-test",
        status: "not_verified",
        reason: expect.stringContaining("denied permission"),
      }),
    );
  });
});
