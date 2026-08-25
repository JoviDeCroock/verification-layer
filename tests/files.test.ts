import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonFile, writeTextFile } from "../packages/core/src/files.js";

describe("atomic report persistence", () => {
  it("atomically replaces files without leaving staging artifacts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "trust-files-"));
    const file = path.join(directory, "nested", "report.json");
    try {
      await writeTextFile(file, "old\n");
      await writeJsonFile(file, { verdict: "trusted" });
      expect(await readFile(file, "utf8")).toBe('{\n  "verdict": "trusted"\n}\n');
      expect(await readdir(path.dirname(file))).toEqual(["report.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
