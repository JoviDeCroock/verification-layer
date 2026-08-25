import { describe, expect, it } from "vitest";
import { trustConfigSchema, type Evidence } from "../packages/core/src/index.js";
import { redactEvidence } from "../packages/core/src/redaction.js";

describe("evidence redaction", () => {
  it("removes configured credentials, environment secrets, and common token formats", () => {
    const config = trustConfigSchema.parse({
      version: 1,
      repository: { name: "redaction", root: "." },
      knowledge: { sources: [] },
      verifiers: [
        {
          id: "cli",
          kind: "cli",
          scope: [],
          tags: [],
          missions: [
            {
              id: "secret",
              executable: process.execPath,
              env: { API_TOKEN: "configured-secret-value" },
            },
          ],
        },
        {
          id: "requests",
          kind: "requests",
          scope: [],
          tags: [],
          requests: [
            {
              id: "secret",
              method: "GET",
              path: "/secret",
              headers: { authorization: "Bearer request-secret-value" },
              expect: { status: 200 },
            },
          ],
        },
      ],
    });
    const evidence: Evidence[] = [
      {
        id: "secret",
        category: "cli",
        status: "failed",
        summary: "configured-secret-value was echoed",
        stdout: "Bearer request-secret-value ghp_abcdefghijklmnopqrstuvwxyz123456",
        measurements: { observed: "configured-secret-value" },
      },
    ];
    const [redacted] = redactEvidence(evidence, config);
    expect(JSON.stringify(redacted)).not.toContain("configured-secret-value");
    expect(JSON.stringify(redacted)).not.toContain("request-secret-value");
    expect(JSON.stringify(redacted)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(redacted)).toContain("[REDACTED:");
  });
});
