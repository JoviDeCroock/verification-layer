import { access, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { TrustConfig } from "../../core/src/index.js";

export interface DiscoveryFinding {
  label: string;
  detail?: string;
}

export interface DiscoveryReport {
  root: string;
  name: string;
  packageManager: string | null;
  languages: string[];
  frameworks: string[];
  found: DiscoveryFinding[];
  knowledge: string[];
  entryPoints: string[];
  routes: string[];
  packages: string[];
  potentialGaps: string[];
  config: TrustConfig;
}

const ignored = ["**/node_modules/**", "**/dist/**", "**/.git/**", "**/.wrangler/**"];

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function files(root: string, patterns: string[]): Promise<string[]> {
  return fg(patterns, { cwd: root, ignore: ignored, onlyFiles: true, dot: true });
}

function scriptCheck(
  id: string,
  kind: TrustConfig["checks"][number]["kind"],
  command: string,
  scope: string[] = ["**/*"],
): TrustConfig["checks"][number] {
  return { id, kind, command, scope, tags: [], required: false, timeout_ms: 120_000 };
}

export async function discoverRepository(rootInput: string): Promise<DiscoveryReport> {
  const root = path.resolve(rootInput);
  const packageFile = path.join(root, "package.json");
  const packageJson = (await exists(packageFile))
    ? (JSON.parse(await readFile(packageFile, "utf8")) as Record<string, unknown>)
    : {};
  const scripts = (packageJson.scripts ?? {}) as Record<string, string>;
  const dependencies = {
    ...((packageJson.dependencies ?? {}) as Record<string, string>),
    ...((packageJson.devDependencies ?? {}) as Record<string, string>),
  };
  const allFiles = await files(root, ["**/*"]);
  const has = (pattern: RegExp) => allFiles.some((file) => pattern.test(file));
  const dep = (name: string) => Object.hasOwn(dependencies, name);
  const found: DiscoveryFinding[] = [];
  const frameworks: string[] = [];
  const languages: string[] = [];

  if (has(/\.(ts|tsx)$/)) languages.push("TypeScript");
  if (has(/\.(js|jsx|mjs|cjs)$/)) languages.push("JavaScript");
  if (has(/\.py$/)) languages.push("Python");
  if (has(/\.go$/)) languages.push("Go");
  if (dep("hono")) frameworks.push("Hono");
  if (dep("preact")) frameworks.push("Preact");
  if (dep("@preact/signals")) frameworks.push("Preact Signals");
  if (dep("drizzle-orm")) frameworks.push("Drizzle ORM");
  if (dep("wrangler") || has(/wrangler\.(jsonc|toml)$/)) frameworks.push("Cloudflare Workers");

  const lockfiles = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
    ["bun.lock", "bun"],
  ] as const;
  let packageManager =
    typeof packageJson.packageManager === "string"
      ? packageJson.packageManager.split("@")[0]!
      : null;
  if (!packageManager) {
    for (const [lockfile, manager] of lockfiles) {
      if (await exists(path.join(root, lockfile))) {
        packageManager = manager;
        break;
      }
    }
  }
  if (!packageManager && (await exists(packageFile))) packageManager = "npm";

  if (languages.length) found.push({ label: languages.join(" + ") });
  if (packageManager) found.push({ label: `${packageManager} project` });
  if (await exists(path.join(root, "pnpm-workspace.yaml"))) found.push({ label: "pnpm workspace" });
  for (const framework of frameworks) found.push({ label: framework });

  const checks: TrustConfig["checks"] = [];
  const addScript = (
    id: string,
    kind: TrustConfig["checks"][number]["kind"],
    candidates: string[],
  ) => {
    const script = candidates.find((candidate) => scripts[candidate]);
    if (!script || !packageManager) return;
    const command = `${packageManager} ${packageManager === "npm" ? "run " : ""}${script}`;
    checks.push(scriptCheck(id, kind, command));
    found.push({ label: `${id} command`, detail: command });
  };
  addScript("typecheck", "static", ["typecheck", "types", "check:types"]);
  addScript("lint", "static", ["lint"]);
  addScript("test", "test", ["test", "test:unit"]);
  addScript("e2e", "e2e", ["test:e2e", "e2e", "playwright"]);
  addScript("build", "static", ["build"]);
  const measurementScript = ["size", "size-limit", "benchmark", "bench"].find(
    (candidate) => scripts[candidate],
  );
  if (measurementScript && packageManager)
    found.push({
      label: "non-functional measurement",
      detail: `${packageManager} ${measurementScript}`,
    });

  const knowledge = await files(root, [
    "AGENTS.md",
    "**/AGENTS.md",
    "CLAUDE.md",
    "**/CLAUDE.md",
    "README.md",
    "docs/**/*.{md,mdx}",
    "adr/**/*.{md,mdx}",
    "ADRs/**/*.{md,mdx}",
  ]);
  if (knowledge.some((file) => file.endsWith("AGENTS.md"))) found.push({ label: "AGENTS.md" });
  const adrs = knowledge.filter((file) => /(^|\/)(adr|ADRs)(\/|$)/.test(file));
  if (adrs.length) found.push({ label: `${adrs.length} ADR${adrs.length === 1 ? "" : "s"}` });

  const ci = await files(root, [".github/workflows/*.{yml,yaml}", ".gitlab-ci.yml"]);
  if (ci.length) found.push({ label: "CI workflows", detail: `${ci.length} file(s)` });
  const testFiles = await files(root, ["**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}"]);
  if (dep("vitest") || has(/vitest\.config\.(ts|js|mjs|cjs)$/))
    found.push({ label: "Vitest", detail: `${testFiles.length} test file(s)` });
  const playwright = await files(root, [
    "playwright.config.{ts,js,mjs,cjs}",
    "**/playwright.config.{ts,js,mjs,cjs}",
  ]);
  if (playwright.length || dep("@playwright/test")) found.push({ label: "Playwright" });
  const verifiers: TrustConfig["verifiers"] = [];
  if ((playwright.length || dep("@playwright/test")) && packageManager) {
    verifiers.push({
      id: "playwright",
      label: "Discovered Playwright suite",
      kind: "playwright",
      executable: packageManager,
      args: ["exec", "playwright", "test"],
      cwd: ".",
      env: {},
      expect: { exit_code: 0, stdout_contains: [], stderr_contains: [] },
      scope: ["src/**", "app/**", "pages/**", "e2e/**", "tests/e2e/**"],
      tags: [],
      required: false,
      timeout_ms: 120_000,
    });
  }
  const customLint = await files(root, [
    "**/eslint-rules/**/*.{ts,js}",
    "**/*eslint-plugin*/**/*.{ts,js}",
  ]);
  if (customLint.length)
    found.push({ label: "custom lint rules", detail: `${customLint.length} file(s)` });

  const entryPoints = allFiles
    .filter((file) => /(^|\/)(index|main|worker|server)\.(ts|tsx|js|jsx)$/.test(file))
    .slice(0, 30);
  const routeFiles = allFiles.filter(
    (file) => /(^|\/)(routes?|pages?|app)\//.test(file) && /\.(ts|tsx|js|jsx)$/.test(file),
  );
  const inlineRoutes: string[] = [];
  for (const file of entryPoints) {
    const source = await readFile(path.join(root, file), "utf8");
    for (const match of source.matchAll(
      /\b(?:app|router)\.(get|post|put|patch|delete|options|all)\(\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      inlineRoutes.push(`${match[1]!.toUpperCase()} ${match[2]} (${file})`);
    }
  }
  const routes = [...routeFiles, ...inlineRoutes];
  const packageFiles = await files(root, ["packages/*/package.json", "apps/*/package.json"]);
  const packages = packageFiles.map((file) => path.dirname(file));

  const surfaces: TrustConfig["surfaces"] = packages.map((packagePath) => ({
    id: packagePath.replace(/\//g, "-"),
    description: `Discovered workspace package ${packagePath}`,
    paths: [`${packagePath}/**`],
    requires: checks.map((check) => check.id),
    risks: [],
    depends_on: [],
  }));
  const discoveredEvidence = [
    ...checks.map((check) => check.id),
    ...verifiers.map((item) => item.id),
  ];
  if (!surfaces.length && discoveredEvidence.length)
    surfaces.push({
      id: "repository",
      description:
        "Repository-wide starter surface generated by discovery; narrow before production",
      paths: ["**/*"],
      requires: discoveredEvidence,
      risks: [],
      depends_on: [],
    });

  const potentialGaps: string[] = [];
  if (
    !checks.some((check) => check.kind === "e2e") &&
    !playwright.length &&
    !dep("@playwright/test")
  )
    potentialGaps.push("No E2E command was detected.");
  if (!knowledge.some((file) => /AGENTS\.md$|CLAUDE\.md$/.test(file)))
    potentialGaps.push("No agent navigation instructions were found.");
  if (!adrs.length) potentialGaps.push("No architecture decision records were found.");
  if (surfaces.some((surface) => surface.id === "repository"))
    potentialGaps.push(
      "A repository-wide starter surface was generated; replace it with approved product boundaries when practical.",
    );
  if (!measurementScript) potentialGaps.push("No non-functional budget command was detected.");
  else
    potentialGaps.push(
      "A non-functional measurement exists, but discovery cannot safely invent its threshold.",
    );
  if (
    !verifiers.some(
      (verifier) => verifier.kind === "agent-browser" || verifier.kind === "agent-device",
    )
  )
    potentialGaps.push(
      "No executable browser/device agent adapter was inferred; repository-specific traversal still needs approval.",
    );
  if (!routes.length && frameworks.some((framework) => ["Preact", "Hono"].includes(framework))) {
    potentialGaps.push("Application routes were not inferable from file ownership alone.");
  }

  const config: TrustConfig = {
    version: 1,
    repository: {
      name: String(packageJson.name ?? path.basename(root)),
      root: ".",
      allow_explicit_changed_files: false,
    },
    knowledge: { sources: knowledge },
    authority: {
      allow_local_approvals: false,
      require_signed_reports: true,
      trusted_approvers: [],
      trusted_reporters: [],
    },
    execution: {
      allow_shell_commands: false,
      inherit_environment: false,
      max_attempts: 1,
      retry_backoff_ms: 250,
    },
    checks,
    invariants: [],
    surfaces,
    verifiers,
    qa: { enabled: false, instructions: [], screenshot: true, timeout_ms: 30_000 },
  };

  return {
    root,
    name: config.repository.name,
    packageManager,
    languages,
    frameworks,
    found,
    knowledge,
    entryPoints,
    routes,
    packages,
    potentialGaps,
    config,
  };
}
