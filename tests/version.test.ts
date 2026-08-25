import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TRUST_VERSION } from "../packages/core/src/version.js";

describe("release version", () => {
  it("keeps CLI provenance aligned with package metadata", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
      private: boolean;
      dependencies: Record<string, string>;
    };
    expect(TRUST_VERSION).toBe(packageJson.version);
    expect(packageJson.private).toBe(false);
    expect(Object.values(packageJson.dependencies)).not.toContain("latest");
  });
});
