import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess, runProcessWithRetries } from "../src/runner/index.js";

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
});
