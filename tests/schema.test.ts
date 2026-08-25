import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runProcess } from "../packages/runner/src/index.js";

async function exportSchemas(directory: string, force = false) {
  return runProcess({
    executable: process.execPath,
    args: [
      "--import",
      "tsx",
      "packages/cli/src/index.ts",
      "schema:export",
      directory,
      ...(force ? ["--force"] : []),
    ],
    cwd: process.cwd(),
    timeoutMs: 30_000,
  });
}

describe("JSON Schema DX", () => {
  it("exports versioned schemas and refuses accidental overwrite", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-schemas-"));
    const output = path.join(directory, "schemas");
    try {
      const first = await exportSchemas(output);
      expect(first.exitCode).toBe(0);
      expect((await readdir(output)).sort()).toEqual([
        "attestation-request.schema.json",
        "audit-entry.schema.json",
        "change-contract.schema.json",
        "doctor.schema.json",
        "incident.schema.json",
        "report.schema.json",
        "start.schema.json",
        "status.schema.json",
        "trust.schema.json",
        "verification-plan.schema.json",
      ]);
      const trust = JSON.parse(await readFile(path.join(output, "trust.schema.json"), "utf8")) as {
        $id: string;
      };
      expect(trust.$id).toBe("urn:executable-trust:v1:policy");

      expect((await exportSchemas(output)).exitCode).toBe(1);
      expect((await exportSchemas(output, true)).exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
