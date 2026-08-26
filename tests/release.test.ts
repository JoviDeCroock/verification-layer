import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

describe("release preparation", () => {
  it("publishes one root package and keeps implementation modules internal", async () => {
    const workspace = YAML.parse(await readFile("pnpm-workspace.yaml", "utf8")) as {
      packages: string[];
    };
    expect(workspace.packages).toEqual(["examples/*"]);

    const internalModules = await readdir("packages", { withFileTypes: true });
    const moduleDirectories = internalModules
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(moduleDirectories).toEqual([
      "cli",
      "contracts",
      "core",
      "discovery",
      "evals",
      "graph",
      "invariants",
      "learning",
      "qa",
      "reporters",
      "runner",
      "verifiers",
    ]);

    await expect(readFile("packages/README.md", "utf8")).resolves.toContain(
      "`executable-trust-layer` package",
    );
    await Promise.all(
      moduleDirectories.map(async (directory) => {
        await expect(readFile(`packages/${directory}/package.json`, "utf8")).rejects.toMatchObject({
          code: "ENOENT",
        });
      }),
    );
  });

  it("ships public Apache-2.0 package metadata and release documents", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      bin: Record<string, string>;
      private: boolean;
      license: string;
      files: string[];
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.private).toBe(false);
    expect(packageJson.license).toBe("Apache-2.0");
    expect(packageJson.bin).toEqual({ trust: "./dist/packages/cli/src/index.js" });
    expect(packageJson.files).toEqual(expect.arrayContaining(["LICENSE", "CHANGELOG.md"]));
    expect(packageJson.scripts).toMatchObject({
      changeset: "changeset",
      version: "changeset version",
      release: "pnpm build:cli && changeset publish",
      "release:check": "pnpm check && npm --cache .trust/npm-cache pack --dry-run",
    });
    expect(packageJson.devDependencies).toMatchObject({
      "@changesets/changelog-github": "^0.6.0",
      "@changesets/cli": "^3.0.0",
    });
    expect(await readFile("LICENSE", "utf8")).toContain("Apache License");
    expect(await readFile("CHANGELOG.md", "utf8")).toContain("## 0.1.0");
  });

  it("creates version pull requests without an npm publishing capability", async () => {
    const config = JSON.parse(await readFile(".changeset/config.json", "utf8")) as {
      access: string;
      baseBranch: string;
      changelog: [string, { repo: string }];
    };
    expect(config).toMatchObject({
      access: "public",
      baseBranch: "main",
      changelog: ["@changesets/changelog-github", { repo: "JoviDeCroock/verification-layer" }],
    });

    const source = await readFile(".github/workflows/release.yml", "utf8");
    const workflow = YAML.parse(source) as {
      jobs: Record<
        string,
        {
          permissions: Record<string, string>;
          steps: Array<{ uses?: string; with?: Record<string, string> }>;
        }
      >;
    };
    expect(Object.keys(workflow.jobs)).toEqual(["version"]);
    expect(workflow.jobs.version?.permissions).not.toHaveProperty("id-token");
    const action = workflow.jobs.version?.steps.find((step) =>
      step.uses?.startsWith("changesets/action@"),
    );
    expect(action).toMatchObject({
      uses: "changesets/action@a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d",
      with: { version: "pnpm run version", commitMode: "github-api" },
    });
    expect(action?.with).not.toHaveProperty("publish");
    expect(source).not.toContain("NPM_TOKEN");
    expect(source).not.toContain("registry-url");
  });
});
