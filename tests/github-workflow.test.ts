import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { renderGitHubWorkflow } from "../packages/cli/src/github.js";

describe("GitHub workflow onboarding", () => {
  it("pins verification to the PR head and uses a secret-backed trusted reporter", () => {
    const workflow = renderGitHubWorkflow({
      configFile: "trust.yaml",
      contractFile: "change-contract.yaml",
      packageManager: "pnpm",
      authorityPackage: "executable-trust-layer@0.1.0",
      reporterId: "ci",
      privateKeySecret: "TRUST_REPORT_PRIVATE_KEY",
    });
    expect(() => YAML.parse(workflow)).not.toThrow();
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
    expect(workflow).not.toMatch(/uses: [^\n]+@v\d/);
    expect(workflow).toContain("--base ${{ github.event.pull_request.base.sha }}");
    expect(workflow).toContain("TRUST_REPORT_PRIVATE_KEY: ${{ secrets.TRUST_REPORT_PRIVATE_KEY }}");
    expect(workflow).toContain("environment: trust-authority");
    expect(workflow).toContain(
      "actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131",
    );
    expect(workflow).toContain('--expected-policy-sha256 "${{ vars.TRUST_POLICY_SHA256 }}"');
    expect(workflow.indexOf("  attest:")).toBeLessThan(
      workflow.indexOf("TRUST_REPORT_PRIVATE_KEY: ${{ secrets.TRUST_REPORT_PRIVATE_KEY }}"),
    );
    expect(workflow.slice(0, workflow.indexOf("  attest:"))).not.toContain(
      "TRUST_REPORT_PRIVATE_KEY",
    );
    expect(workflow).toContain("if-no-files-found: error");
  });

  it("rejects values that could inject workflow syntax", () => {
    expect(() =>
      renderGitHubWorkflow({
        configFile: "trust.yaml\npermissions: write-all",
        contractFile: "change-contract.yaml",
        packageManager: "npm",
        authorityPackage: "executable-trust-layer@0.1.0",
        reporterId: "ci",
        privateKeySecret: "TRUST_REPORT_PRIVATE_KEY",
      }),
    ).toThrow("unsupported characters");
  });
});
