#!/usr/bin/env node
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { cac } from "cac";
import pc from "picocolors";
import YAML from "yaml";
import {
  computeVerdict,
  changeContractSchema,
  doctorResultSchema,
  incidentSchema,
  reportAttestationRequestSchema,
  slugify,
  startResultSchema,
  statusResultSchema,
  trustConfigSchema,
  trustReportSchema,
  type TrustConfig,
  type TrustReport,
} from "../core/index.js";
import {
  loadChangeContract,
  loadTrustConfig,
  loadTrustReport,
  writeJsonFile,
  writeTextFile,
  writeYamlFile,
} from "../core/files.js";
import { verifyChange } from "../core/verify.js";
import { contractSummary, reviewContract } from "../contracts/index.js";
import { discoverRepository } from "../discovery/index.js";
import { renderDiscovery } from "../discovery/render.js";
import { buildVerificationGraph, createVerificationPlan } from "../graph/index.js";
import { proposeFromIncident, proposeLearnings } from "../learning/index.js";
import {
  reportAssuranceLevel,
  renderConciseTerminalReport,
  renderMarkdownReport,
  renderTerminalReport,
} from "../reporters/index.js";
import {
  approvalDigest,
  changeSetDigest,
  currentGitIdentity,
  gitTracksPath,
  resolveGitChangeSet,
  sha256,
} from "../core/provenance.js";
import {
  approvalSignatureDigest,
  attestationFromRequest,
  authorityKeyValidityProblem,
  createReportAttestationRequest,
  generateAuthorityKeyPair,
  publicKeyIsValid,
  signDigest,
  createReportAttestation,
  trustedReporterMatchesPrivateKey,
  verifyReportAttestation,
} from "../core/attestations.js";
import { publishGitHubReport } from "./ci.js";
import { renderGitHubWorkflow } from "./github.js";
import { validateReportSemantics } from "../core/report-validation.js";
import { TRUST_VERSION } from "../core/version.js";
import { runProcess } from "../runner/index.js";
import { appendAuditJournal, parseAuditJournal } from "../core/audit.js";
import { generateMissions } from "../qa/index.js";

const cli = cac("trust");
cli.option("--all", "Show the complete expert command reference");
const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
};
const values = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)];

function formatFrom(value: unknown, allowed: readonly string[]): string {
  const format = String(value);
  if (!allowed.includes(format))
    throw new Error(`--format must be ${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}.`);
  return format;
}

function shellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  if (process.platform === "win32") return JSON.stringify(value);
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1)
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function commandSuggestion(input: string): string | undefined {
  const commands = cli.commands.map((command) => command.name).filter(Boolean);
  const closest = commands.sort(
    (left, right) => editDistance(input, left) - editDistance(input, right),
  )[0];
  return closest && editDistance(input, closest) <= Math.max(2, Math.floor(input.length / 3))
    ? closest
    : undefined;
}

function friendlyErrorMessage(error: unknown): string {
  const nodeError = error as NodeJS.ErrnoException & { path?: string };
  const issues = (error as { issues?: Array<{ path: PropertyKey[]; message: string }> }).issues;
  if (nodeError.code === "ENOENT")
    return `Required file not found: ${nodeError.path ?? "unknown path"}. Run trust status for the recommended recovery step.`;
  if (Array.isArray(issues))
    return `Trust data is invalid:\n${issues
      .slice(0, 8)
      .map((issue) => `- ${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("\n")}${issues.length > 8 ? `\n- …and ${issues.length - 8} more issue(s)` : ""}`;
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function promptForIntent(): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      'Pass --intent with the user-visible outcome, for example: trust --intent "Users can reset their password safely".',
    );
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await input.question("What should this change accomplish for the user?\n> ")).trim();
  } finally {
    input.close();
  }
}

async function privateKeyFrom(
  file: unknown,
  environmentName: unknown,
): Promise<string | undefined> {
  if (file && environmentName)
    throw new Error("Pass a private key file or environment variable, not both.");
  if (file) return readFile(path.resolve(String(file)), "utf8");
  if (!environmentName) return undefined;
  const name = String(environmentName);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    throw new Error(`Invalid private-key environment variable name ${JSON.stringify(name)}.`);
  const value = process.env[name];
  if (!value) throw new Error(`Private-key environment variable ${name} is empty or unavailable.`);
  // Authority material is consumed once and must never reach repository-owned
  // checks, even when compatibility policy enables full environment inheritance.
  delete process.env[name];
  return value.replace(/\\n/g, "\n");
}

function isoTimestamp(value: unknown, label: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(String(value));
  if (!Number.isFinite(timestamp.getTime())) throw new Error(`${label} must be a valid timestamp.`);
  return timestamp.toISOString();
}

async function bundledSchemaDirectory(): Promise<string> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(moduleDirectory, "../../schemas"),
    path.resolve("schemas"),
  ]) {
    try {
      await access(path.join(candidate, "trust.schema.json"));
      return candidate;
    } catch {
      // Try the source-tree, installed-package, then working-directory layout.
    }
  }
  throw new Error("Bundled JSON Schemas are unavailable in this installation.");
}

async function bundledProofSummary(): Promise<{
  thesis: string;
  broken: { verdict: string; matrix: Array<{ status: string; summary: string }> };
  fixed: { verdict: string; matrix: Array<{ status: string; summary: string }> };
}> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(moduleDirectory, "../../examples/demo-app/.trust/runs/proof-summary.json"),
    path.resolve("examples/demo-app/.trust/runs/proof-summary.json"),
  ]) {
    try {
      const parsed = JSON.parse(await readFile(candidate, "utf8")) as Awaited<
        ReturnType<typeof bundledProofSummary>
      >;
      if (parsed.broken?.matrix && parsed.fixed?.matrix) return parsed;
    } catch {
      // Try source-tree, installed-package, then working-directory layout.
    }
  }
  throw new Error("The bundled proof summary is unavailable in this installation.");
}

async function ensureLocalArtifactsIgnored(repositoryRoot: string): Promise<string> {
  const ignoreFile = path.join(repositoryRoot, ".trust", ".gitignore");
  let existing = "";
  try {
    existing = await readFile(ignoreFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const lines = new Set(existing.split(/\r?\n/).filter(Boolean));
  const required = ["runs/", "keys/*.private.pem"];
  if (required.every((line) => lines.has(line))) return ignoreFile;
  for (const line of required) lines.add(line);
  await mkdir(path.dirname(ignoreFile), { recursive: true });
  await writeFile(ignoreFile, `${[...lines].join("\n")}\n`, { encoding: "utf8", mode: 0o644 });
  return ignoreFile;
}

async function excludeUntrackedGuidedArtifacts(
  repositoryRoot: string,
  changedFiles: string[],
  artifactFiles: string[],
): Promise<string[]> {
  const generated = new Set<string>();
  for (const file of artifactFiles) {
    if (await gitTracksPath(repositoryRoot, file)) continue;
    const relative = path.relative(repositoryRoot, file);
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`))
      generated.add(relative.split(path.sep).join("/"));
  }
  return changedFiles.filter((file) => !generated.has(file));
}

async function formatGuidedArtifacts(
  repositoryRoot: string,
  artifactFiles: string[],
): Promise<void> {
  const packageFile = path.join(repositoryRoot, "package.json");
  if (!(await fileExists(packageFile))) return;
  const packageJson = JSON.parse(await readFile(packageFile, "utf8")) as Record<string, unknown>;
  const dependencies = {
    ...((packageJson.dependencies ?? {}) as Record<string, string>),
    ...((packageJson.devDependencies ?? {}) as Record<string, string>),
  };
  const formatter = Object.hasOwn(dependencies, "oxfmt")
    ? { binary: "oxfmt", args: ["--write"] }
    : Object.hasOwn(dependencies, "prettier")
      ? { binary: "prettier", args: ["--write"] }
      : null;
  if (!formatter) return;
  const executable = path.join(
    repositoryRoot,
    "node_modules",
    ".bin",
    `${formatter.binary}${process.platform === "win32" ? ".cmd" : ""}`,
  );
  if (!(await fileExists(executable))) return;
  const files = artifactFiles.filter(
    (file) =>
      path.relative(repositoryRoot, file) !== ".." &&
      !path.relative(repositoryRoot, file).startsWith(`..${path.sep}`),
  );
  if (!files.length) return;
  const result = await runProcess({
    executable,
    args: [...formatter.args, ...files],
    cwd: repositoryRoot,
    timeoutMs: 30_000,
    inheritEnv: false,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `Could not format generated trust artifacts with ${formatter.binary}: ${result.stderr || result.stdout}`,
    );
}

async function newestYamlFile(directory: string): Promise<string | undefined> {
  const candidates = (await readdir(directory).catch(() => []))
    .filter((file) => /\.ya?ml$/i.test(file))
    .map((file) => path.join(directory, file));
  if (!candidates.length) return undefined;
  const dated = await Promise.all(
    candidates.map(async (file) => ({ file, modified: (await stat(file)).mtimeMs })),
  );
  return dated.sort((left, right) => right.modified - left.modified)[0]!.file;
}

async function createExternalAttestation(
  report: Parameters<typeof createReportAttestationRequest>[0],
  signerId: string,
  executable: string,
  args: string[],
  environmentNames: string[],
  timeoutMs: number,
) {
  const environment: Record<string, string> = {};
  for (const name of environmentNames) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
      throw new Error(`Invalid signer environment variable name ${JSON.stringify(name)}.`);
    const value = process.env[name];
    if (!value) throw new Error(`Signer environment variable ${name} is empty or unavailable.`);
    environment[name] = value;
    delete process.env[name];
  }
  const request = reportAttestationRequestSchema.parse(
    createReportAttestationRequest(report, signerId),
  );
  const signerDirectory = await mkdtemp(path.join(os.tmpdir(), "trust-external-signer-"));
  let result;
  try {
    result = await runProcess({
      executable,
      args,
      cwd: signerDirectory,
      timeoutMs,
      stdin: `${JSON.stringify(request)}\n`,
      env: environment,
      inheritEnv: false,
    });
  } finally {
    await rm(signerDirectory, { recursive: true, force: true });
  }
  if (result.exitCode !== 0)
    throw new Error(
      `External signer failed with exit ${result.exitCode}${result.timedOut ? " after timing out" : ""}.`,
    );
  let signature: unknown;
  try {
    signature = (JSON.parse(result.stdout) as { signature?: unknown }).signature;
  } catch {
    throw new Error("External signer did not return a JSON response.");
  }
  if (typeof signature !== "string" || !signature)
    throw new Error("External signer response requires a non-empty base64 signature.");
  return attestationFromRequest(request, signature);
}

function storedReportProblems(report: TrustReport, config: TrustConfig): string[] {
  const problems: string[] = [];
  const attestationProblem = verifyReportAttestation(report, config);
  if (attestationProblem) problems.push(attestationProblem);
  problems.push(...reviewContract(report.contract, config).blockingIssues);
  if (report.provenance.digests.policy_sha256 !== sha256(config))
    problems.push("The report was produced under a different repository policy.");
  if (report.provenance.digests.contract_sha256 !== sha256(report.contract))
    problems.push("The embedded contract does not match its recorded digest.");
  if (report.provenance.digests.plan_sha256 !== sha256(report.plan))
    problems.push("The embedded plan does not match its recorded digest.");
  if (report.verdict !== computeVerdict(report.evidence))
    problems.push("The stored verdict does not match the structured evidence.");
  problems.push(...validateReportSemantics(report, config));
  return problems;
}

cli.command("try", "See the broken-versus-fixed product proof with no setup").action(async () => {
  const proof = await bundledProofSummary();
  const failed = [
    ...new Map(
      proof.broken.matrix
        .filter((item) => item.status === "failed")
        .map((item) => [item.summary, item]),
    ).values(),
  ];
  const fixedFailures = proof.fixed.matrix.filter(
    (item) => item.status === "failed" || item.status === "not_verified",
  );
  console.log(pc.bold("EXECUTABLE TRUST — GUIDED PROOF"));
  console.log(pc.dim("Bundled result from the full deterministic demo matrix."));
  console.log(
    "\nOrdinary checks pass in both variants. Independent QA exercises retries and races.",
  );
  console.log(`\n${pc.red("BROKEN · NOT TRUSTED")}`);
  for (const item of failed.slice(0, 3)) console.log(`${pc.red("✗")} ${item.summary}`);
  console.log(`\n${pc.green("FIXED · TRUSTED")}`);
  if (!fixedFailures.length)
    console.log(`${pc.green("✓")} The same evidence matrix establishes every approved behavior.`);
  else for (const item of fixedFailures) console.log(`${pc.yellow("!")} ${item.summary}`);
  console.log(`\n${proof.thesis}`);
  console.log(
    '\nNext: run `trust --intent "Describe the user-visible outcome"` in your repository.',
  );
});

cli
  .command("status [repository]", "Show current trust state and the single best next action")
  .option("--config <file>", "Policy path; defaults to <repository>/trust.yaml")
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (repository = ".", options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    const discovery = await discoverRepository(repository);
    const identity = await currentGitIdentity(discovery.root);
    const gitInitialized = Boolean(
      identity.headSha || (await fileExists(path.join(discovery.root, ".git"))),
    );
    const configFile = path.resolve(options.config ?? path.join(discovery.root, "trust.yaml"));
    const hasPolicy = await fileExists(configFile);
    const problems: string[] = [];
    let config: TrustConfig | undefined;
    if (hasPolicy)
      try {
        config = await loadTrustConfig(configFile);
      } catch (error) {
        problems.push(`Policy ${configFile}: ${friendlyErrorMessage(error)}`);
      }
    const contractFile = await newestYamlFile(path.join(discovery.root, ".trust", "contracts"));
    if (contractFile)
      try {
        await loadChangeContract(contractFile);
      } catch (error) {
        problems.push(`Contract ${contractFile}: ${friendlyErrorMessage(error)}`);
      }
    const reportFile = path.join(discovery.root, ".trust", "runs", "latest", "report.json");
    const workflowFile = path.join(discovery.root, ".github", "workflows", "trust.yml");
    const [hasReport, hasWorkflow] = await Promise.all([
      fileExists(reportFile),
      fileExists(workflowFile),
    ]);
    let report: TrustReport | undefined;
    if (hasReport)
      try {
        report = await loadTrustReport(reportFile);
      } catch (error) {
        problems.push(`Report ${reportFile}: ${friendlyErrorMessage(error)}`);
      }
    const resolvedStatusChangeSet = identity.headSha
      ? await resolveGitChangeSet(discovery.root)
      : { changedFiles: [] };
    const changeSet = {
      ...resolvedStatusChangeSet,
      changedFiles: await excludeUntrackedGuidedArtifacts(
        discovery.root,
        resolvedStatusChangeSet.changedFiles,
        [
          configFile,
          path.join(discovery.root, ".trust", ".gitignore"),
          path.join(discovery.root, ".trust", "contracts", "current.yaml"),
        ],
      ),
    };
    const policyMode = !config
      ? "none"
      : config.authority?.allow_local_approvals === true &&
          config.authority?.require_signed_reports === false
        ? "local"
        : config.authority?.allow_local_approvals === false &&
            config.authority?.require_signed_reports === true
          ? "attested"
          : "custom";
    let next: { action: string; command: string; reason: string };
    if (!gitInitialized)
      next = {
        action: "initialize_git",
        command: "git init",
        reason:
          "Initialize Git first; then review ignore rules and choose the intended baseline files.",
      };
    else if (!identity.headSha)
      next = {
        action: "create_initial_commit",
        command: "git status --short",
        reason:
          "Review the baseline, stage only intended files, and create the initial commit before verification.",
      };
    else if (hasPolicy && !config)
      next = {
        action: "repair_policy",
        command: "trust schema:export .trust/schemas",
        reason:
          "The policy is unreadable; validate it against the exported schema before running repository code.",
      };
    else if (!config)
      next = {
        action: "start",
        command: 'trust --intent "Describe the user-visible outcome"',
        reason: "Discovery is ready; provide the one intent it cannot infer.",
      };
    else if (policyMode === "custom")
      next = {
        action: "check_readiness",
        command: `trust doctor --config ${shellArgument(configFile)} --require local`,
        reason:
          "The authority settings are customized; check their effective readiness before running evidence.",
      };
    else if (contractFile && problems.some((problem) => problem.startsWith("Contract ")))
      next = {
        action: "repair_contract",
        command: "trust contract:init --help",
        reason:
          "The newest contract is unreadable and must be replaced or repaired before verification.",
      };
    else if (hasReport && !report)
      next = {
        action: "rerun_verification",
        command:
          policyMode === "local"
            ? 'trust --intent "Describe the user-visible outcome"'
            : "trust verify --help",
        reason:
          "The latest generated report is unreadable; rerun evidence to replace it atomically.",
      };
    else if (policyMode === "local" && hasWorkflow)
      next = {
        action: "resolve_enforcement_conflict",
        command: `trust doctor --config ${shellArgument(configFile)} --require attested`,
        reason:
          "A GitHub trust workflow exists while authority is still local; inspect the readiness blockers before changing either side.",
      };
    else if (policyMode === "local" && !changeSet.changedFiles.length)
      next = {
        action: "make_change",
        command: 'trust --intent "Describe the user-visible outcome"',
        reason:
          "The local policy is ready; make a Git-visible product change before running evidence.",
      };
    else if (report && report.verdict !== "trusted")
      next = {
        action: "explain",
        command: `trust explain --report ${shellArgument(reportFile)}`,
        reason: "The latest verdict has blockers or missing evidence that need attention.",
      };
    else if (policyMode === "local" && report?.verdict === "trusted")
      next = {
        action: "enable_github",
        command: "trust enable github",
        reason: "Local evidence is trusted; protected CI is the next assurance step.",
      };
    else if (policyMode === "local")
      next = {
        action: "start",
        command: 'trust --intent "Describe the user-visible outcome"',
        reason: "The local policy is ready to verify the current Git change.",
      };
    else if (!contractFile)
      next = {
        action: "create_contract",
        command: "trust contract:init --help",
        reason: "Attested policy exists, but no approved change contract was found.",
      };
    else if (!hasWorkflow)
      next = {
        action: "create_ci",
        command: "trust ci:init --help",
        reason: "Attested policy and contract exist, but the protected workflow is missing.",
      };
    else if (report && reportAssuranceLevel(report) === "attested" && report.verdict === "trusted")
      next = {
        action: "archive_evidence",
        command: `trust audit:append ${shellArgument(reportFile)}`,
        reason: "The latest result is trusted and attested; preserve it in the audit chain.",
      };
    else
      next = {
        action: "check_attested_readiness",
        command: `trust doctor --config ${shellArgument(configFile)} --contract ${shellArgument(contractFile)} --require attested`,
        reason: "The enforcement files exist; validate every authority and adapter reference.",
      };
    const status = statusResultSchema.parse({
      version: 1,
      repository: {
        root: discovery.root,
        name: discovery.name,
        git: {
          initialized: gitInitialized,
          head_sha: identity.headSha,
          branch: identity.branch,
          dirty: identity.dirty,
          changed_files: changeSet.changedFiles,
        },
      },
      setup: {
        policy: hasPolicy ? configFile : null,
        policy_mode: policyMode,
        contract: contractFile ?? null,
        report: hasReport ? reportFile : null,
        github_workflow: hasWorkflow ? workflowFile : null,
      },
      evidence: config
        ? {
            checks: config.checks.length,
            invariants: config.invariants.length,
            verifiers: config.verifiers.length,
            surfaces: config.surfaces.length,
          }
        : null,
      latest_run: report
        ? {
            verdict: report.verdict,
            assurance: reportAssuranceLevel(report),
            created_at: report.created_at,
            run_id: report.run_id,
          }
        : null,
      problems,
      next,
    });
    if (format === "json") {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(pc.bold(`TRUST STATUS — ${discovery.name}`));
    console.log(
      `${identity.headSha ? pc.green("✓") : pc.red("✗")} Git ${identity.headSha ? `${identity.branch ?? "detached"} @ ${identity.headSha.slice(0, 8)}` : gitInitialized ? "has no commits" : "not initialized"}`,
    );
    console.log(
      `${hasPolicy ? pc.green("✓") : pc.dim("○")} Policy ${hasPolicy ? `${policyMode} (${configFile})` : "not created"}`,
    );
    console.log(
      `${contractFile ? pc.green("✓") : pc.dim("○")} Contract ${contractFile ?? "not created"}`,
    );
    console.log(
      `${report ? (report.verdict === "trusted" ? pc.green("✓") : pc.red("✗")) : pc.dim("○")} Latest run ${report ? `${report.verdict} · ${reportAssuranceLevel(report)} assurance` : "not available"}`,
    );
    console.log(
      `${hasWorkflow ? pc.green("✓") : pc.dim("○")} GitHub enforcement ${hasWorkflow ? "configured locally" : "not configured"}`,
    );
    for (const problem of problems) console.log(pc.red(`! ${problem}`));
    console.log(pc.bold("\nNext"));
    console.log(next.reason);
    console.log(pc.cyan(`$ ${next.command}`));
    console.log(pc.dim("\nAutomation: trust status --format json"));
  });

cli
  .command("start [repository]", "Go from a repository and one intent sentence to a local verdict")
  .option("--intent <text>", "User-visible outcome this change must accomplish")
  .option(
    "--evidence <id>",
    "Evidence explicitly supporting the behavior; repeat or comma-separate",
  )
  .option("--risk <risk>", "Declared risk; repeat or comma-separate")
  .option("--base <ref>", "Git base ref used to derive committed changes")
  .option("--config <file>", "Local policy path; defaults to <repository>/trust.yaml")
  .option("--contract <file>", "Generated approved contract path")
  .option("--output <directory>", "Evidence output directory", {
    default: ".trust/runs/latest",
  })
  .option("--preview-url <url>", "Running application preview URL")
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (repository = ".", options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    const discovery = await discoverRepository(repository);
    const intent = String(options.intent ?? (await promptForIntent())).trim();
    if (!intent) throw new Error("Intent must not be empty.");
    const identity = await currentGitIdentity(discovery.root);
    if (!identity.headSha)
      throw new Error(
        "Guided start requires a Git repository with an initial commit so evidence can be bound to a real change.",
      );
    const configFile = path.resolve(options.config ?? path.join(discovery.root, "trust.yaml"));
    const contractFile = path.resolve(
      options.contract ?? path.join(discovery.root, ".trust", "contracts", "current.yaml"),
    );
    const ignoreFile = path.join(discovery.root, ".trust", ".gitignore");
    // Resolve the candidate before writing onboarding artifacts. The generated
    // policy, contract, and report must never become evidence about themselves.
    const resolvedChangeSet = await resolveGitChangeSet(discovery.root, options.base);
    const changeSet = {
      ...resolvedChangeSet,
      changedFiles: await excludeUntrackedGuidedArtifacts(
        discovery.root,
        resolvedChangeSet.changedFiles,
        [configFile, contractFile, ignoreFile],
      ),
    };
    let config: TrustConfig;
    let createdPolicy = false;
    if (await fileExists(configFile)) {
      config = await loadTrustConfig(configFile);
      if (
        config.authority?.allow_local_approvals !== true ||
        config.authority?.require_signed_reports !== false
      )
        throw new Error(
          `Existing policy ${configFile} requires enforced authority. Use trust contract:init and trust verify, or choose a separate local policy with --config.`,
        );
    } else {
      config = trustConfigSchema.parse({
        ...discovery.config,
        repository: {
          ...discovery.config.repository,
          root: path.relative(path.dirname(configFile), discovery.root) || ".",
          allow_explicit_changed_files: false,
        },
        authority: {
          allow_local_approvals: true,
          require_signed_reports: false,
          trusted_approvers: [],
          trusted_reporters: [],
        },
      });
      await mkdir(path.dirname(configFile), { recursive: true });
      await writeFile(configFile, YAML.stringify(config, { lineWidth: 100 }), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      createdPolicy = true;
      await formatGuidedArtifacts(discovery.root, [configFile]);
    }
    if (
      !createdPolicy &&
      configFile === path.join(discovery.root, "trust.yaml") &&
      !(await gitTracksPath(discovery.root, configFile))
    )
      await formatGuidedArtifacts(discovery.root, [configFile]);
    const evidence = [
      ...config.checks.map((item) => item.id),
      ...config.invariants.map((item) => item.id),
      ...config.verifiers.map((item) => item.id),
      ...(config.qa.enabled ? ["qa"] : []),
    ];
    const behaviorEvidence = list(options.evidence);
    const unknownBehaviorEvidence = behaviorEvidence.filter((id) => !evidence.includes(id));
    if (unknownBehaviorEvidence.length)
      throw new Error(
        `Behavior evidence is not configured: ${unknownBehaviorEvidence.join(", ")}. Available evidence: ${evidence.join(", ")}.`,
      );
    if (!evidence.length)
      throw new Error(
        `No executable evidence was discovered. Add a test, build, typecheck, or verifier, then rerun trust --intent. Policy: ${configFile}`,
      );
    if (!config.surfaces.length)
      throw new Error(
        `No product surface was discovered. Add a surface to ${configFile}, then rerun trust --intent.`,
      );
    if (format === "terminal") {
      console.log(pc.bold(`EXECUTABLE TRUST — ${discovery.name}`));
      console.log(
        `${pc.green("✓")} ${discovery.packageManager ?? "Repository"} project; ${evidence.length} executable evidence source(s)`,
      );
      console.log(
        `${pc.green("✓")} ${createdPolicy ? "Created" : "Using"} safe local policy ${configFile}`,
      );
    }
    if (!changeSet.changedFiles.length) {
      const command = `trust --intent ${shellArgument(intent)}`;
      const reason = "No Git changes are currently available to verify.";
      if (format === "json")
        console.log(
          JSON.stringify(
            startResultSchema.parse({
              version: 1,
              status: "no_changes",
              repository: { root: discovery.root, name: discovery.name },
              policy: configFile,
              created_policy: createdPolicy,
              change_set: [],
              next: { command, reason },
            }),
            null,
            2,
          ),
        );
      else {
        console.log(reason);
        console.log(`Next: make a change, then run ${command}.`);
      }
      return;
    }
    const id = slugify(intent) || "change";
    const draft = changeContractSchema.parse({
      version: 1,
      id,
      intent,
      expected_behaviors: [
        {
          id: "primary-behavior",
          description: intent,
          evidence: behaviorEvidence.length ? behaviorEvidence : evidence,
          evidence_mapping: behaviorEvidence.length ? "explicit" : "inferred",
        },
      ],
      affected_surfaces: config.surfaces.map((surface) => surface.id),
      risks: list(options.risk),
      required_evidence: evidence,
      excluded: [],
      approval: { status: "draft" },
    });
    const withMissions = changeContractSchema.parse({
      ...draft,
      qa_missions: generateMissions(draft),
    });
    const approvedContent = {
      ...withMissions,
      approval: {
        status: "approved" as const,
        approved_by: "local-user",
        approved_at: new Date().toISOString(),
        method: "local" as const,
      },
    };
    const contract = changeContractSchema.parse({
      ...approvedContent,
      approval: {
        ...approvedContent.approval,
        content_sha256: approvalDigest(approvedContent),
      },
    });
    if (options.contract && (await fileExists(contractFile)))
      throw new Error(
        `Refusing to overwrite existing contract ${contractFile}. Pass --contract with a new path.`,
      );
    await ensureLocalArtifactsIgnored(discovery.root);
    await writeYamlFile(contractFile, contract);
    await formatGuidedArtifacts(discovery.root, [contractFile]);
    const outputDirectory = path.resolve(discovery.root, String(options.output));
    if (format === "terminal") {
      console.log(`${pc.green("✓")} Approved local intent: ${intent}`);
      console.log(`${pc.green("✓")} Git change set: ${changeSet.changedFiles.length} file(s)`);
      console.log(pc.dim(`  ${changeSet.changedFiles.join(", ")}`));
      console.log(pc.dim(`  Evidence: ${evidence.join(", ")}`));
      console.log("\nRunning relevant evidence…\n");
    }
    const report = await verifyChange({
      config,
      contract,
      repositoryRoot: discovery.root,
      changedFiles: changeSet.changedFiles,
      changedFilesSource: "git",
      ...(changeSet.baseSha ? { baseSha: changeSet.baseSha } : {}),
      outputDirectory,
      ...(options.previewUrl ? { previewUrl: String(options.previewUrl) } : {}),
    });
    const reportFile = path.join(outputDirectory, "report.json");
    if (format === "json")
      console.log(
        JSON.stringify(
          startResultSchema.parse({
            version: 1,
            status: "completed",
            repository: { root: discovery.root, name: discovery.name },
            policy: configFile,
            created_policy: createdPolicy,
            contract: contractFile,
            report_file: reportFile,
            report,
          }),
          null,
          2,
        ),
      );
    else {
      console.log(pc.dim(`Contract: ${contractFile}`));
      process.stdout.write(renderConciseTerminalReport(report, reportFile));
    }
    if (report.verdict !== "trusted") process.exitCode = 1;
  });

cli
  .command("init [repository]", "Discover repository verification and write an initial trust model")
  .option("--output <file>", "Output YAML path")
  .option("--no-write", "Only print discovery")
  .action(async (repository = ".", options) => {
    const report = await discoverRepository(repository);
    process.stdout.write(renderDiscovery(report));
    if (options.write !== false) {
      const output = path.resolve(options.output ?? path.join(report.root, "trust.generated.yaml"));
      await writeYamlFile(output, report.config);
      console.log(pc.green(`\nWrote ${output}`));
    }
  });

cli
  .command("setup [repository]", "Bootstrap strict policy and separate authority identities")
  .option("--config <file>", "Policy output; defaults to <repository>/trust.yaml")
  .option("--keys <directory>", "Private-key directory; defaults to <repository>/.trust/keys")
  .option("--approver <id>", "Approver identity", { default: "product-owner" })
  .option("--reporter <id>", "Reporter identity", { default: "ci" })
  .option("--valid-days <days>", "Authority key lifetime", { default: 365 })
  .action(async (repository = ".", options) => {
    const discovery = await discoverRepository(repository);
    const approverId = String(options.approver).trim();
    const reporterId = String(options.reporter).trim();
    if (!approverId || !reporterId) throw new Error("Authority identities must not be empty.");
    if (approverId === reporterId)
      throw new Error("Approver and reporter identities must be distinct.");
    const validDays = Number(options.validDays);
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 3_650)
      throw new Error("--valid-days must be an integer from 1 through 3650.");
    const configFile = path.resolve(options.config ?? path.join(discovery.root, "trust.yaml"));
    const keyDirectory = path.resolve(options.keys ?? path.join(discovery.root, ".trust", "keys"));
    const targets = {
      config: configFile,
      approverPrivate: path.join(keyDirectory, "approver.private.pem"),
      approverPublic: path.join(keyDirectory, "approver.public.txt"),
      reporterPrivate: path.join(keyDirectory, "reporter.private.pem"),
      reporterPublic: path.join(keyDirectory, "reporter.public.txt"),
    };
    await ensureLocalArtifactsIgnored(discovery.root);
    const existing: string[] = [];
    for (const file of Object.values(targets))
      try {
        await access(file);
        existing.push(file);
      } catch {
        // The target is available.
      }
    if (existing.length)
      throw new Error(`Refusing to overwrite existing setup file(s): ${existing.join(", ")}`);
    const approver = generateAuthorityKeyPair();
    const reporter = generateAuthorityKeyPair();
    const notBefore = new Date().toISOString();
    const notAfter = new Date(Date.now() + validDays * 86_400_000).toISOString();
    const config = trustConfigSchema.parse({
      ...discovery.config,
      repository: {
        ...discovery.config.repository,
        root: path.relative(path.dirname(configFile), discovery.root) || ".",
        allow_explicit_changed_files: false,
      },
      authority: {
        allow_local_approvals: false,
        require_signed_reports: true,
        trusted_approvers: [
          {
            id: approverId,
            public_key_base64: approver.publicKeyBase64,
            not_before: notBefore,
            not_after: notAfter,
          },
        ],
        trusted_reporters: [
          {
            id: reporterId,
            public_key_base64: reporter.publicKeyBase64,
            not_before: notBefore,
            not_after: notAfter,
          },
        ],
      },
    });
    const created: string[] = [];
    try {
      await mkdir(keyDirectory, { recursive: true });
      for (const [file, contents, mode] of [
        [targets.approverPrivate, approver.privateKeyPem, 0o600],
        [targets.approverPublic, `${approver.publicKeyBase64}\n`, 0o644],
        [targets.reporterPrivate, reporter.privateKeyPem, 0o600],
        [targets.reporterPublic, `${reporter.publicKeyBase64}\n`, 0o644],
      ] as const) {
        await writeFile(file, contents, { encoding: "utf8", flag: "wx", mode });
        created.push(file);
      }
      await mkdir(path.dirname(configFile), { recursive: true });
      await writeFile(configFile, YAML.stringify(config, { lineWidth: 100 }), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o644,
      });
      created.push(configFile);
    } catch (error) {
      await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
      throw new Error(
        `Setup could not complete atomically: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(pc.green(`Created attested-ready trust policy ${configFile}`));
    console.log(`Approver ${approverId}: ${approver.fingerprint} (${targets.approverPrivate})`);
    console.log(`Reporter ${reporterId}: ${reporter.fingerprint} (${targets.reporterPrivate})`);
    console.log(`Keys are active until ${notAfter}.`);
    console.log("\nNext:");
    console.log(`1. trust doctor --config ${configFile} --require attested`);
    console.log(`2. Review the generated policy when you need narrower product surfaces.`);
    console.log(`3. Create and sign a contract with ${targets.approverPrivate}.`);
    console.log(`4. Store ${targets.reporterPrivate} in protected CI authority.`);
  });

cli
  .command("policy:digest", "Print the canonical repository policy SHA-256 trust root")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .action(async (options) => {
    const config = await loadTrustConfig(path.resolve(options.config));
    console.log(sha256(config));
  });

cli
  .command("schema:export [directory]", "Export versioned JSON Schemas for editor tooling")
  .option("--force", "Replace existing exported schema files")
  .action(async (directory = ".trust/schemas", options) => {
    const source = await bundledSchemaDirectory();
    const output = path.resolve(directory);
    const files = (await readdir(source)).filter((file) => file.endsWith(".schema.json")).sort();
    await mkdir(output, { recursive: true });
    for (const file of files) {
      const target = path.join(output, file);
      if (!options.force)
        try {
          await access(target);
          throw new Error(`Refusing to overwrite exported schema ${target}; pass --force.`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      await writeTextFile(target, await readFile(path.join(source, file), "utf8"));
    }
    console.log(pc.green(`Exported ${files.length} schemas to ${output}`));
    console.log(
      pc.dim("YAML hint: # yaml-language-server: $schema=.trust/schemas/trust.schema.json"),
    );
  });

cli
  .command("authority:register <public-key>", "Register a trusted authority public key")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--id <id>", "Stable signer identity")
  .option("--role <role>", "approver or reporter")
  .option("--not-before <timestamp>", "Optional key activation timestamp")
  .option("--not-after <timestamp>", "Optional key expiry timestamp")
  .action(async (publicKeyFile, options) => {
    const id = String(options.id ?? "").trim();
    if (!id) throw new Error("--id is required to register an authority key.");
    const role = String(options.role ?? "").trim();
    if (role !== "approver" && role !== "reporter")
      throw new Error("--role must be approver or reporter.");
    const publicKeyBase64 = (await readFile(path.resolve(publicKeyFile), "utf8")).trim();
    if (!publicKeyIsValid(publicKeyBase64))
      throw new Error("The public key file does not contain a valid Ed25519 SPKI key.");
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    config.authority ??= {};
    const field = role === "approver" ? "trusted_approvers" : "trusted_reporters";
    const keys = (config.authority[field] ??= []);
    if (keys.some((item) => item.id === id))
      throw new Error(`Authority key ID ${JSON.stringify(id)} is already registered for ${role}.`);
    keys.push({
      id,
      public_key_base64: publicKeyBase64,
      ...(options.notBefore
        ? { not_before: isoTimestamp(options.notBefore, "--not-before")! }
        : {}),
      ...(options.notAfter ? { not_after: isoTimestamp(options.notAfter, "--not-after")! } : {}),
    });
    await writeYamlFile(configFile, trustConfigSchema.parse(config));
    console.log(pc.green(`Registered ${id} as a trusted ${role} in ${configFile}`));
  });

cli
  .command("authority:list", "List trusted authority identities and lifecycle state")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .action(async (options) => {
    const config = await loadTrustConfig(path.resolve(options.config));
    const now = new Date().toISOString();
    console.log(pc.bold("TRUSTED AUTHORITY IDENTITIES"));
    for (const [role, keys] of [
      ["approver", config.authority?.trusted_approvers ?? []],
      ["reporter", config.authority?.trusted_reporters ?? []],
    ] as const) {
      for (const key of keys) {
        const problem = authorityKeyValidityProblem(key, now);
        console.log(
          `${problem ? pc.red("✗") : pc.green("✓")} ${role.padEnd(8)} ${key.id} ${sha256(key.public_key_base64).slice(0, 16)}${problem ? ` — ${problem}` : " — active"}`,
        );
      }
    }
  });

cli
  .command("authority:revoke <id>", "Revoke a trusted authority identity")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--role <role>", "approver or reporter")
  .option("--reason <text>", "Required audit reason")
  .action(async (id, options) => {
    const role = String(options.role ?? "");
    if (role !== "approver" && role !== "reporter")
      throw new Error("--role must be approver or reporter.");
    const reason = String(options.reason ?? "").trim();
    if (!reason) throw new Error("--reason is required to revoke an authority identity.");
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const field = role === "approver" ? "trusted_approvers" : "trusted_reporters";
    const key = (config.authority?.[field] ?? []).find((candidate) => candidate.id === id);
    if (!key) throw new Error(`${role} ${JSON.stringify(id)} is not registered.`);
    if (key.revoked_at) throw new Error(`${role} ${JSON.stringify(id)} is already revoked.`);
    key.revoked_at = new Date().toISOString();
    key.revocation_reason = reason;
    await writeYamlFile(configFile, trustConfigSchema.parse(config));
    console.log(pc.green(`Revoked ${role} ${id} in ${configFile}`));
    console.log(pc.dim("Existing reports now fail verification under the updated policy digest."));
  });

cli
  .command("authority:keygen [prefix]", "Generate an Ed25519 authority key pair")
  .option("--id <id>", "Stable signer identity")
  .action(async (prefix, options) => {
    const id = String(options.id ?? "").trim();
    if (!id) throw new Error("--id is required to generate an authority key.");
    const outputPrefix = path.resolve(prefix ?? path.join(".trust", "keys", id));
    const privateFile = `${outputPrefix}.private.pem`;
    const publicFile = `${outputPrefix}.public.txt`;
    const existing: string[] = [];
    for (const file of [privateFile, publicFile]) {
      try {
        await access(file);
        existing.push(file);
      } catch {
        // The path is available.
      }
    }
    if (existing.length)
      throw new Error(
        `Refusing to overwrite existing authority key file(s): ${existing.join(", ")}`,
      );
    await mkdir(path.dirname(outputPrefix), { recursive: true });
    const key = generateAuthorityKeyPair();
    try {
      await writeFile(privateFile, key.privateKeyPem, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await writeFile(publicFile, `${key.publicKeyBase64}\n`, {
        encoding: "utf8",
        mode: 0o644,
        flag: "wx",
      });
    } catch (error) {
      throw new Error(
        `Could not create authority key files without overwriting existing data: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(pc.green(`Generated Ed25519 authority key ${id} (${key.fingerprint})`));
    console.log(`Private key: ${privateFile}`);
    console.log(`Public key: ${publicFile}`);
    console.log("\nAdd this entry under authority.trusted_approvers or trusted_reporters:");
    process.stdout.write(
      YAML.stringify([{ id, public_key_base64: key.publicKeyBase64 }], { lineWidth: 100 }),
    );
  });

cli
  .command("ci:init [output]", "Create a fail-closed GitHub Actions trust workflow")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--contract <file>", "Approved change contract", {
    default: "change-contract.yaml",
  })
  .option("--package-manager <name>", "pnpm or npm", { default: "pnpm" })
  .option("--authority-package <spec>", "Required immutable authority CLI package spec")
  .option("--report-signer <id>", "Registered trusted reporter identity", { default: "ci" })
  .option("--key-secret <name>", "GitHub Actions secret containing the reporter private key", {
    default: "TRUST_REPORT_PRIVATE_KEY",
  })
  .action(async (output = ".github/workflows/trust.yml", options) => {
    const packageManager = String(options.packageManager);
    if (packageManager !== "pnpm" && packageManager !== "npm")
      throw new Error("--package-manager must be pnpm or npm.");
    if (!options.authorityPackage)
      throw new Error(
        "--authority-package is required and must name an approved exact package version.",
      );
    const configFile = path.resolve(options.config);
    const contractFile = path.resolve(options.contract);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(contractFile);
    const review = reviewContract(contract, config);
    if (!review.valid)
      throw new Error(
        `The contract is not ready for CI:\n${review.blockingIssues.map((issue) => `- ${issue}`).join("\n")}`,
      );
    const reporterId = String(options.reportSigner);
    const reporter = (config.authority?.trusted_reporters ?? []).find(
      (candidate) => candidate.id === reporterId,
    );
    if (!reporter)
      throw new Error(
        `Reporter ${JSON.stringify(reporterId)} is not registered in authority.trusted_reporters.`,
      );
    const reporterProblem = authorityKeyValidityProblem(reporter, new Date().toISOString());
    if (reporterProblem)
      throw new Error(`Reporter ${JSON.stringify(reporterId)} is not active: ${reporterProblem}`);
    const workflow = renderGitHubWorkflow({
      configFile: path.relative(process.cwd(), configFile),
      contractFile: path.relative(process.cwd(), contractFile),
      packageManager,
      authorityPackage: String(options.authorityPackage),
      reporterId,
      privateKeySecret: String(options.keySecret),
    });
    const outputFile = path.resolve(output);
    await mkdir(path.dirname(outputFile), { recursive: true });
    try {
      await writeFile(outputFile, workflow, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      throw new Error(
        `Refusing to overwrite CI workflow ${outputFile}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(pc.green(`Created ${outputFile}`));
    console.log(
      `Add the reporter private key as GitHub Actions secret ${String(options.keySecret)}, then require the attest job before merge.`,
    );
    console.log(`Set repository variable TRUST_POLICY_SHA256 to ${sha256(config)}.`);
    console.log(
      "Protect the trust-authority environment; only its isolated attestation job receives the key.",
    );
  });

cli
  .command("enable <target>", "Upgrade local verification to protected merge enforcement")
  .option("--config <file>", "Policy", { default: "trust.yaml" })
  .option("--contract <file>", "Approved contract; defaults to the newest .trust contract")
  .option("--output <file>", "GitHub Actions workflow", {
    default: ".github/workflows/trust.yml",
  })
  .option("--approver <id>", "Approver identity", { default: "product-owner" })
  .option("--reporter <id>", "Reporter identity", { default: "ci" })
  .option("--valid-days <days>", "Authority key lifetime", { default: 365 })
  .option("--authority-package <spec>", "Exact authority CLI package spec")
  .option("--key-secret <name>", "GitHub secret for the reporter private key", {
    default: "TRUST_REPORT_PRIVATE_KEY",
  })
  .action(async (target, options) => {
    if (target !== "github") throw new Error("The supported enable target is github.");
    const configFile = path.resolve(options.config);
    const originalConfig = await loadTrustConfig(configFile);
    const repositoryRoot = path.resolve(path.dirname(configFile), originalConfig.repository.root);
    let contractFile: string;
    if (options.contract) contractFile = path.resolve(options.contract);
    else {
      const newest = await newestYamlFile(path.join(repositoryRoot, ".trust", "contracts"));
      if (!newest)
        throw new Error(
          "No generated contract was found. Pass --contract or run trust --intent first.",
        );
      contractFile = newest;
    }
    const contract = await loadChangeContract(contractFile);
    const approverId = String(options.approver).trim();
    const reporterId = String(options.reporter).trim();
    if (!approverId || !reporterId || approverId === reporterId)
      throw new Error("Approver and reporter identities must be non-empty and distinct.");
    const validDays = Number(options.validDays);
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 3_650)
      throw new Error("--valid-days must be an integer from 1 through 3650.");
    const keyDirectory = path.join(repositoryRoot, ".trust", "keys");
    const approverPrivateFile = path.join(keyDirectory, "approver.private.pem");
    const approverPublicFile = path.join(keyDirectory, "approver.public.txt");
    const reporterPrivateFile = path.join(keyDirectory, "reporter.private.pem");
    const reporterPublicFile = path.join(keyDirectory, "reporter.public.txt");
    const outputFile = path.resolve(repositoryRoot, String(options.output));
    for (const file of [
      approverPrivateFile,
      approverPublicFile,
      reporterPrivateFile,
      reporterPublicFile,
      outputFile,
    ])
      if (await fileExists(file))
        throw new Error(`Refusing to overwrite enforcement file ${file}.`);
    const approver = generateAuthorityKeyPair();
    const reporter = generateAuthorityKeyPair();
    const notBefore = new Date().toISOString();
    const notAfter = new Date(Date.now() + validDays * 86_400_000).toISOString();
    const config = trustConfigSchema.parse({
      ...originalConfig,
      repository: { ...originalConfig.repository, allow_explicit_changed_files: false },
      authority: {
        allow_local_approvals: false,
        require_signed_reports: true,
        trusted_approvers: [
          {
            id: approverId,
            public_key_base64: approver.publicKeyBase64,
            not_before: notBefore,
            not_after: notAfter,
          },
        ],
        trusted_reporters: [
          {
            id: reporterId,
            public_key_base64: reporter.publicKeyBase64,
            not_before: notBefore,
            not_after: notAfter,
          },
        ],
      },
    });
    const approvedContent = {
      ...contract,
      approval: {
        status: "approved" as const,
        approved_by: approverId,
        approved_at: new Date().toISOString(),
        method: "ed25519" as const,
        key_id: approverId,
      },
    };
    const digestBound = {
      ...approvedContent,
      approval: {
        ...approvedContent.approval,
        content_sha256: approvalDigest(approvedContent),
      },
    };
    const signedContract = changeContractSchema.parse({
      ...digestBound,
      approval: {
        ...digestBound.approval,
        signature: signDigest(approvalSignatureDigest(digestBound), approver.privateKeyPem),
      },
    });
    const review = reviewContract(signedContract, config);
    if (!review.valid)
      throw new Error(
        `The contract is not ready for enforcement:\n${review.blockingIssues.map((issue) => `- ${issue}`).join("\n")}`,
      );
    const discovery = await discoverRepository(repositoryRoot);
    if (discovery.packageManager !== "npm" && discovery.packageManager !== "pnpm")
      throw new Error(
        `GitHub enablement currently supports npm and pnpm projects; discovered ${discovery.packageManager ?? "no package manager"}. Use trust ci:init --package-manager after defining the install strategy for this repository.`,
      );
    const packageManager = discovery.packageManager;
    const authorityPackage = String(
      options.authorityPackage ?? `executable-trust-layer@${TRUST_VERSION}`,
    );
    const workflow = renderGitHubWorkflow({
      configFile: path.relative(repositoryRoot, configFile),
      contractFile: path.relative(repositoryRoot, contractFile),
      packageManager,
      authorityPackage,
      reporterId,
      privateKeySecret: String(options.keySecret),
    });
    await ensureLocalArtifactsIgnored(repositoryRoot);
    const originalConfigText = await readFile(configFile, "utf8");
    const originalContractText = await readFile(contractFile, "utf8");
    const created: string[] = [];
    try {
      await mkdir(keyDirectory, { recursive: true });
      for (const [file, contents, mode] of [
        [approverPrivateFile, approver.privateKeyPem, 0o600],
        [approverPublicFile, `${approver.publicKeyBase64}\n`, 0o644],
        [reporterPrivateFile, reporter.privateKeyPem, 0o600],
        [reporterPublicFile, `${reporter.publicKeyBase64}\n`, 0o644],
      ] as const) {
        await writeFile(file, contents, { encoding: "utf8", flag: "wx", mode });
        created.push(file);
      }
      await writeYamlFile(configFile, config);
      await writeYamlFile(contractFile, signedContract);
      await mkdir(path.dirname(outputFile), { recursive: true });
      await writeFile(outputFile, workflow, { encoding: "utf8", flag: "wx", mode: 0o644 });
      created.push(outputFile);
    } catch (error) {
      await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
      await writeFile(configFile, originalConfigText, "utf8");
      await writeFile(contractFile, originalContractText, "utf8");
      throw new Error(
        `GitHub enablement could not complete atomically: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    console.log(pc.green("GitHub merge enforcement is ready locally."));
    console.log(`Workflow: ${outputFile}`);
    console.log(`Signed contract: ${contractFile}`);
    console.log(`Reporter private key: ${reporterPrivateFile}`);
    console.log(`GitHub secret: ${String(options.keySecret)}`);
    console.log(`Repository variable TRUST_POLICY_SHA256: ${sha256(config)}`);
    console.log(`Authority package: ${authorityPackage} (must be available to the CI runner)`);
    console.log("Required status check: Trust authority / attest");
    console.log("Next: protect the trust-authority environment and add the secret and variable.");
  });

cli
  .command("contract:init [output]", "Create a draft, evidence-linked change contract")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--id <id>", "Stable change identifier")
  .option("--intent <text>", "Approved-intent summary")
  .option("--surface <ids>", "Comma-separated affected surfaces")
  .option("--risk <risks>", "Comma-separated risks")
  .option("--evidence <ids>", "Comma-separated evidence IDs")
  .action(async (output = "change-contract.yaml", options) => {
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const intent = String(options.intent ?? "").trim();
    if (!intent) throw new Error("--intent is required to create a change contract.");
    const affectedSurfaces = list(options.surface);
    if (!affectedSurfaces.length)
      throw new Error(
        `--surface is required. Available surfaces: ${config.surfaces.map((item) => item.id).join(", ") || "none configured"}.`,
      );
    const unknownSurfaces = affectedSurfaces.filter(
      (id) => !config.surfaces.some((surface) => surface.id === id),
    );
    if (unknownSurfaces.length)
      throw new Error(
        `Unknown surface(s): ${unknownSurfaces.join(", ")}. Run trust inspect first.`,
      );
    const evidence = list(options.evidence);
    const derivedEvidence = evidence.length
      ? evidence
      : [
          ...new Set(
            config.surfaces
              .filter((surface) => affectedSurfaces.includes(surface.id))
              .flatMap((surface) => surface.requires),
          ),
        ];
    if (!derivedEvidence.length)
      throw new Error(
        "No evidence could be derived from the selected surfaces. Add surface requirements or pass --evidence.",
      );
    const id = String(options.id ?? slugify(intent));
    const draft = changeContractSchema.parse({
      version: 1,
      id,
      intent,
      expected_behaviors: [
        {
          id: "primary-behavior",
          description: intent,
          evidence: derivedEvidence,
        },
      ],
      affected_surfaces: affectedSurfaces,
      risks: list(options.risk),
      required_evidence: derivedEvidence,
      excluded: [],
      approval: { status: "draft" },
    });
    const contract = changeContractSchema.parse({
      ...draft,
      qa_missions: generateMissions(draft),
    });
    await writeYamlFile(path.resolve(output), contract);
    console.log(pc.green(`Created draft contract ${path.resolve(output)}`));
    console.log(pc.dim("Review behavior coverage, risks, and exclusions before approval."));
  });

cli
  .command("contract:approve <contract>", "Validate and approve a change contract")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--by <identity>", "Approver identity")
  .option("--key <file>", "Ed25519 private key; omit only when local approvals are allowed")
  .option("--key-env <name>", "Environment variable containing the Ed25519 private key")
  .option("--output <file>", "Write to a different file")
  .action(async (contractFile, options) => {
    const approvedBy = String(options.by ?? "").trim();
    if (!approvedBy) throw new Error("--by is required to approve a change contract.");
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(path.resolve(contractFile));
    const privateKeyPem = await privateKeyFrom(options.key, options.keyEnv);
    const approvedContent = {
      ...contract,
      approval: {
        status: "approved" as const,
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
        method: privateKeyPem ? ("ed25519" as const) : ("local" as const),
        ...(privateKeyPem ? { key_id: approvedBy } : {}),
      },
    };
    const digestBound = {
      ...approvedContent,
      approval: {
        ...approvedContent.approval,
        content_sha256: approvalDigest(approvedContent),
      },
    };
    const approved = privateKeyPem
      ? {
          ...digestBound,
          approval: {
            ...digestBound.approval,
            signature: signDigest(approvalSignatureDigest(digestBound), privateKeyPem),
          },
        }
      : digestBound;
    const review = reviewContract(approved, config);
    if (!review.valid)
      throw new Error(
        `Contract cannot be approved:\n${review.blockingIssues.map((issue) => `- ${issue}`).join("\n")}`,
      );
    const output = path.resolve(options.output ?? contractFile);
    await writeYamlFile(output, approved);
    console.log(pc.green(`Approved ${output}`));
    console.log(
      pc.dim(
        privateKeyPem
          ? `Signed as trusted Ed25519 identity ${approvedBy}.`
          : "Approval is local because repository policy explicitly allows local authority.",
      ),
    );
  });

cli
  .command("doctor", "Validate configuration, evidence references, and local adapter readiness")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--contract <file>", "Optional change contract")
  .option("--require <level>", "Required readiness: trial, local, or attested", {
    default: "local",
  })
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (options) => {
    if (options.format !== "terminal" && options.format !== "json")
      throw new Error("--format must be terminal or json.");
    const readinessLevels = ["trial", "local", "attested"] as const;
    const requestedLevel = String(options.require);
    if (!readinessLevels.some((level) => level === requestedLevel))
      throw new Error("--require must be trial, local, or attested.");
    const requiredLevel = requestedLevel as (typeof readinessLevels)[number];
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    const localProblems: string[] = [];
    const attestedProblems: string[] = [];
    const warnings: string[] = [];
    const trustedApprovers = config.authority?.trusted_approvers ?? [];
    const trustedReporters = config.authority?.trusted_reporters ?? [];
    const now = new Date().toISOString();
    const activeApprovers = trustedApprovers.filter(
      (key) => !authorityKeyValidityProblem(key, now),
    );
    const activeReporters = trustedReporters.filter(
      (key) => !authorityKeyValidityProblem(key, now),
    );
    const evidenceSourceCount =
      config.checks.length + config.invariants.length + config.verifiers.length;
    if (!evidenceSourceCount)
      localProblems.push(
        "verification: no checks, invariants, or verifiers are configured; an empty policy cannot establish trust",
      );
    if (!config.surfaces.length)
      localProblems.push(
        "verification: no product surfaces are configured; approved intent cannot be scoped to the repository",
      );
    if (config.authority?.allow_local_approvals !== true && !activeApprovers.length)
      localProblems.push(
        "authority: local approvals are disabled but no active trusted approver keys are configured",
      );
    if (!activeApprovers.length)
      attestedProblems.push("authority: attested readiness requires an active approver key");
    if (!activeReporters.length)
      attestedProblems.push("authority: attested readiness requires an active reporter key");
    if (config.authority?.allow_local_approvals === true)
      attestedProblems.push("authority: attested readiness does not allow local approvals");
    if (config.authority?.require_signed_reports === false)
      attestedProblems.push("authority: attested readiness requires signed reports");
    if (config.repository.allow_explicit_changed_files === true)
      attestedProblems.push("repository: attested readiness requires Git-derived change sets");
    if (config.authority?.allow_local_approvals === true)
      warnings.push("authority: local approvals are enabled");
    if (config.authority?.require_signed_reports === false)
      warnings.push("authority: signed reports are not required");
    if (config.repository.allow_explicit_changed_files === true)
      warnings.push("repository: explicit changed-file lists are allowed");
    if (
      (config.checks.some((check) => "command" in check) || config.invariants.length > 0) &&
      config.execution?.allow_shell_commands !== true
    )
      localProblems.push(
        "execution: shell-backed checks exist but allow_shell_commands is not enabled",
      );
    if (config.execution?.allow_shell_commands === true)
      warnings.push("execution: trusted repository shell commands are enabled");
    if (config.execution?.inherit_environment === true)
      warnings.push("execution: child processes inherit the full environment");
    if ((config.execution?.max_attempts ?? 1) > 1)
      warnings.push(
        `execution: up to ${config.execution!.max_attempts} attempts are recorded; any failed attempt remains fail-closed evidence`,
      );
    if (
      config.surfaces.some(
        (surface) => surface.id === "repository" && surface.paths.includes("**/*"),
      )
    )
      warnings.push(
        "surfaces: repository-wide starter surface is active; replace it with approved product boundaries when practical",
      );
    for (const key of [...trustedApprovers, ...trustedReporters]) {
      if (!publicKeyIsValid(key.public_key_base64))
        localProblems.push(`authority: ${key.id} does not contain a valid Ed25519 public key`);
      const validityProblem = authorityKeyValidityProblem(key, now);
      if (validityProblem) warnings.push(`authority: ${validityProblem}`);
      else if (key.not_after && new Date(key.not_after).getTime() - Date.now() < 30 * 86_400_000)
        warnings.push(`authority: key ${key.id} expires within 30 days at ${key.not_after}`);
    }
    for (const verifier of config.verifiers) {
      if (verifier.kind === "agent-browser" || verifier.kind === "agent-device") {
        if (!verifier.executor)
          localProblems.push(`${verifier.id}: missing QA executor provenance in repository policy`);
        const adapter = path.resolve(repositoryRoot, verifier.adapter);
        try {
          await access(adapter);
        } catch {
          localProblems.push(`${verifier.id}: missing adapter ${adapter}`);
        }
      }
      if (verifier.kind === "playwright" && verifier.executable.includes("/")) {
        const executable = path.resolve(repositoryRoot, verifier.cwd, verifier.executable);
        try {
          await access(executable);
        } catch {
          localProblems.push(`${verifier.id}: missing executable ${executable}`);
        }
      }
    }
    if (config.qa.enabled) {
      if (!config.qa.adapter) localProblems.push("qa: enabled but no adapter is configured");
      if (!config.qa.executor)
        localProblems.push(
          "qa: enabled but executor provenance is not declared in repository policy",
        );
      if (config.qa.adapter)
        try {
          await access(path.resolve(repositoryRoot, config.qa.adapter));
        } catch {
          localProblems.push(
            `qa: missing adapter ${path.resolve(repositoryRoot, config.qa.adapter)}`,
          );
        }
    }
    if (options.contract) {
      const contract = await loadChangeContract(path.resolve(options.contract));
      localProblems.push(...reviewContract(contract, config).blockingIssues);
    }
    const readiness = {
      trial: true,
      local: localProblems.length === 0,
      attested: localProblems.length === 0 && attestedProblems.length === 0,
    };
    const problems =
      requiredLevel === "trial"
        ? []
        : requiredLevel === "local"
          ? localProblems
          : [...localProblems, ...attestedProblems];
    const result = doctorResultSchema.parse({
      version: 1,
      repository: config.repository.name,
      required_level: requiredLevel,
      readiness,
      ready: readiness[requiredLevel],
      counts: {
        checks: config.checks.length,
        invariants: config.invariants.length,
        verifiers: config.verifiers.length,
        surfaces: config.surfaces.length,
        active_approvers: activeApprovers.length,
        active_reporters: activeReporters.length,
      },
      verifiers: config.verifiers.map((item) => ({ id: item.id, kind: item.kind })),
      warnings,
      problems,
    });
    if (options.format === "json") console.log(JSON.stringify(result, null, 2));
    else {
      console.log(pc.bold(`TRUST DOCTOR — ${config.repository.name}`));
      console.log(`Checks: ${result.counts.checks}`);
      console.log(`Invariants: ${result.counts.invariants}`);
      console.log(
        `Verifiers: ${result.verifiers.map((item) => `${item.id} (${item.kind})`).join(", ") || "none"}`,
      );
      console.log(`Surfaces: ${result.counts.surfaces}`);
      console.log("");
      console.log(`${result.readiness.trial ? pc.green("✓") : pc.red("✗")} Trial readiness`);
      console.log(`${result.readiness.local ? pc.green("✓") : pc.red("✗")} Local readiness`);
      console.log(`${result.readiness.attested ? pc.green("✓") : pc.dim("○")} Attested readiness`);
      for (const warning of warnings) console.log(pc.yellow(`! ${warning}`));
      if (problems.length) for (const problem of problems) console.log(pc.red(`✗ ${problem}`));
      else console.log(pc.green(`✓ Ready for ${requiredLevel} verification.`));
    }
    if (!result.ready) process.exitCode = 1;
  });

cli
  .command(
    "inspect [repository]",
    "Inspect discovery and optionally render a configured verification graph",
  )
  .option("--config <file>", "Existing trust configuration")
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (repository = ".", options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    const report = await discoverRepository(repository);
    const config = options.config ? await loadTrustConfig(path.resolve(options.config)) : undefined;
    const graph = config ? buildVerificationGraph(config) : undefined;
    if (format === "json") {
      console.log(JSON.stringify({ version: 1, discovery: report, graph: graph ?? null }, null, 2));
      return;
    }
    process.stdout.write(renderDiscovery(report));
    if (graph) {
      console.log(pc.bold("\nVerification graph:"));
      for (const node of graph) {
        console.log(`\n${node.surface}`);
        for (const pattern of node.paths) console.log(`  ${pc.dim(pattern)}`);
        for (const evidence of node.evidence) console.log(`  └─ ${evidence}`);
      }
    }
  });

cli
  .command(
    "plan <contract>",
    "Validate an approved contract and produce a selective verification plan",
  )
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--changed <files>", "Comma-separated changed files")
  .option("--base <ref>", "Git base ref used to derive committed changes")
  .option("--output <file>", "Plan JSON output", { default: ".trust/plan.json" })
  .option("--no-write", "Preview without writing the plan file")
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (contractFile, options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(path.resolve(contractFile));
    const review = reviewContract(contract, config);
    const changed = options.changed
      ? { changedFiles: list(options.changed), source: "explicit" as const }
      : {
          ...(await resolveGitChangeSet(
            path.resolve(path.dirname(configFile), config.repository.root),
            options.base,
          )),
          source: "git" as const,
        };
    const plan = createVerificationPlan(config, contract, changed.changedFiles);
    const outputFile = path.resolve(options.output);
    if (review.valid && options.write !== false) await writeJsonFile(outputFile, plan);
    if (format === "json") {
      console.log(
        JSON.stringify(
          {
            version: 1,
            valid: review.valid,
            review: { warnings: review.warnings, blocking_issues: review.blockingIssues },
            change_set: {
              source: changed.source,
              files: changed.changedFiles,
              ...("baseSha" in changed && changed.baseSha ? { base_sha: changed.baseSha } : {}),
            },
            plan,
            output: review.valid && options.write !== false ? outputFile : null,
          },
          null,
          2,
        ),
      );
      if (!review.valid) process.exitCode = 2;
      return;
    }
    console.log(contractSummary(contract));
    for (const warning of review.warnings) console.log(pc.yellow(`! ${warning}`));
    for (const issue of review.blockingIssues) console.log(pc.red(`✗ ${issue}`));
    console.log(`\nSelected: ${plan.selected_checks.join(", ") || "no checks"}`);
    console.log(`Invariants: ${plan.selected_invariants.join(", ") || "none"}`);
    console.log(`Verifiers: ${plan.selected_verifiers.join(", ") || "none"}`);
    console.log(`QA: ${plan.qa_required ? "required" : "not required"}`);
    console.log(`Change set: ${changed.source} (${changed.changedFiles.length} file(s))`);
    if (review.valid)
      console.log(
        options.write === false
          ? pc.dim("Preview only; no plan was written.")
          : `Wrote: ${outputFile}`,
      );
    if (!review.valid) process.exitCode = 2;
  });

cli
  .command("verify", "Execute selected evidence and produce terminal, JSON, and Markdown reports")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--contract <file>", "Approved change contract", { default: "change-contract.yaml" })
  .option("--changed <files>", "Comma-separated changed files")
  .option("--base <ref>", "Git base ref used to derive committed changes")
  .option("--preview-url <url>", "Running application preview URL")
  .option("--output <directory>", "Evidence output directory", { default: ".trust/runs/latest" })
  .option("--report-key <file>", "Ed25519 private key used to attest the report")
  .option("--report-key-env <name>", "Environment variable containing the report private key")
  .option("--report-signer <id>", "Trusted reporter identity for --report-key")
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .option("--verbose", "Print the complete evidence report instead of the concise verdict")
  .option("--no-ci-output", "Do not publish GitHub Actions summary, outputs, or annotations")
  .action(async (options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    if (format === "json" && options.verbose)
      throw new Error("--verbose only applies to terminal output; omit it with --format json.");
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(path.resolve(options.contract));
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    const outputDirectory = path.resolve(options.output);
    const privateKeyPem = await privateKeyFrom(options.reportKey, options.reportKeyEnv);
    if (Boolean(privateKeyPem) !== Boolean(options.reportSigner))
      throw new Error(
        "A report private key (--report-key or --report-key-env) and --report-signer must be provided together.",
      );
    const reportSigner = privateKeyPem
      ? {
          id: String(options.reportSigner),
          privateKeyPem,
        }
      : undefined;
    const explicitChangedFiles = list(options.changed);
    const changeSet = options.changed
      ? { changedFiles: explicitChangedFiles, source: "explicit" as const }
      : {
          ...(await resolveGitChangeSet(repositoryRoot, options.base)),
          source: "git" as const,
        };
    const controller = new AbortController();
    const cancel = () => {
      console.error(pc.yellow("\nCancelling verification and terminating active evidence…"));
      controller.abort(new Error("Verification cancelled by user."));
    };
    process.once("SIGINT", cancel);
    const report = await verifyChange({
      config,
      contract,
      repositoryRoot,
      changedFiles: changeSet.changedFiles,
      changedFilesSource: changeSet.source,
      ...("baseSha" in changeSet && changeSet.baseSha ? { baseSha: changeSet.baseSha } : {}),
      outputDirectory,
      ...(reportSigner ? { reportSigner } : {}),
      ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
      signal: controller.signal,
    }).finally(() => process.removeListener("SIGINT", cancel));
    process.stdout.write(
      format === "json"
        ? `${JSON.stringify(report, null, 2)}\n`
        : options.verbose
          ? renderTerminalReport(report)
          : renderConciseTerminalReport(report, path.join(outputDirectory, "report.json")),
    );
    if (options.ciOutput !== false && format !== "json")
      await publishGitHubReport(report, path.join(outputDirectory, "report.json"));
    if (report.verdict !== "trusted") process.exitCode = 1;
  });

cli
  .command("report:verify <result>", "Verify report integrity, authority, and attestation")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--expected-policy-sha256 <digest>", "Out-of-band trusted policy digest")
  .option("--require-trusted", "Fail unless the valid report verdict is trusted")
  .action(async (result, options) => {
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    const report = await loadTrustReport(path.resolve(result));
    const problems: string[] = [];
    const warnings: string[] = [];
    const currentPolicyDigest = sha256(config);
    if (
      options.expectedPolicySha256 !== undefined &&
      String(options.expectedPolicySha256) !== currentPolicyDigest
    )
      problems.push("The current repository policy does not match the expected trust-root digest.");
    const attestationProblem = report.attestation
      ? verifyReportAttestation(report, config)
      : config.authority?.require_signed_reports !== false
        ? "The report has no attestation."
        : null;
    if (report.attestation) problems.push(...storedReportProblems(report, config));
    else if (attestationProblem) problems.push(attestationProblem);
    if (!report.attestation && config.authority?.require_signed_reports === false)
      warnings.push("Report attestation is not required by this repository policy.");
    if (!report.attestation) {
      problems.push(...reviewContract(report.contract, config).blockingIssues);
      if (report.provenance.digests.policy_sha256 !== currentPolicyDigest)
        problems.push("The report was produced under a different repository policy.");
      if (report.provenance.digests.contract_sha256 !== sha256(report.contract))
        problems.push("The embedded contract does not match its recorded digest.");
      if (report.provenance.digests.plan_sha256 !== sha256(report.plan))
        problems.push("The embedded plan does not match its recorded digest.");
      if (report.verdict !== computeVerdict(report.evidence))
        problems.push("The stored verdict does not match the structured evidence.");
      problems.push(...validateReportSemantics(report, config));
    }
    const currentChangeSetDigest = await changeSetDigest(repositoryRoot, report.plan.changed_files);
    if (report.provenance.digests.change_set_sha256 !== currentChangeSetDigest)
      problems.push("The current changed-file contents do not match the attested snapshot.");
    const identity = await currentGitIdentity(repositoryRoot);
    if (
      report.provenance.repository.head_sha &&
      report.provenance.repository.head_sha !== identity.headSha
    )
      problems.push("The current Git HEAD does not match the report provenance.");
    if (options.requireTrusted && report.verdict !== "trusted")
      problems.push(`A trusted verdict is required; this report is ${report.verdict}.`);
    console.log(pc.bold(`TRUST REPORT VERIFY — ${report.run_id}`));
    console.log(`Verdict: ${report.verdict}`);
    console.log(`Commit: ${report.provenance.repository.head_sha ?? "unavailable"}`);
    console.log(`Contract: ${report.provenance.digests.contract_sha256}`);
    if (report.attestation)
      console.log(`Signer: ${report.attestation.signer_id} at ${report.attestation.signed_at}`);
    for (const warning of warnings) console.log(pc.yellow(`! ${warning}`));
    if (problems.length) {
      for (const problem of problems) console.log(pc.red(`✗ ${problem}`));
      process.exitCode = 1;
    } else console.log(pc.green("✓ Report integrity and authority are valid."));
  });

cli
  .command("reports:prune [directory]", "Prune old completed report directories")
  .option("--keep <count>", "Number of newest report directories to retain", { default: 20 })
  .option("--confirm", "Delete the selected directories; otherwise only preview")
  .action(async (directory = ".trust/runs", options) => {
    const root = path.resolve(directory);
    const keep = Number(options.keep);
    if (!Number.isInteger(keep) || keep < 0)
      throw new Error("--keep must be a non-negative integer.");
    if (root === path.parse(root).root || root === process.cwd())
      throw new Error("Refusing to prune a filesystem or repository root.");
    const entries = await readdir(root, { withFileTypes: true });
    const reports: Array<{ directory: string; modifiedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const reportDirectory = path.join(root, entry.name);
      try {
        const details = await stat(path.join(reportDirectory, "report.json"));
        reports.push({ directory: reportDirectory, modifiedAt: details.mtimeMs });
      } catch {
        // Never delete directories that are not recognizable completed report runs.
      }
    }
    reports.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const selected = reports.slice(keep);
    if (!selected.length) {
      console.log(pc.green(`Nothing to prune; ${reports.length} completed report(s) found.`));
      return;
    }
    console.log(`${options.confirm ? "Pruning" : "Would prune"} ${selected.length} report(s):`);
    for (const report of selected) console.log(`- ${report.directory}`);
    if (!options.confirm) {
      console.log(pc.dim("Run again with --confirm to delete only the listed report directories."));
      return;
    }
    for (const report of selected) await rm(report.directory, { recursive: true, force: false });
    console.log(pc.green(`Retained the ${Math.min(keep, reports.length)} newest report(s).`));
  });

cli
  .command("audit:append <result>", "Append a signed report to a tamper-evident audit journal")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--journal <file>", "Hash-chained JSONL journal", {
    default: ".trust/audit/reports.jsonl",
  })
  .option("--expected-policy-sha256 <digest>", "Out-of-band trusted policy digest")
  .option("--expected-head <digest>", "Previously anchored audit head digest")
  .option("--expected-count <count>", "Previously anchored audit record count")
  .action(async (result, options) => {
    const config = await loadTrustConfig(path.resolve(options.config));
    const policyDigest = sha256(config);
    if (
      options.expectedPolicySha256 !== undefined &&
      String(options.expectedPolicySha256) !== policyDigest
    )
      throw new Error(
        "The current repository policy does not match the expected trust-root digest.",
      );
    const expectedHead = options.expectedHead ? String(options.expectedHead) : undefined;
    if (expectedHead && !/^[a-f0-9]{64}$/.test(expectedHead))
      throw new Error("--expected-head must be a lowercase SHA-256 digest.");
    const expectedCount =
      options.expectedCount === undefined ? undefined : Number(options.expectedCount);
    if (expectedCount !== undefined && (!Number.isInteger(expectedCount) || expectedCount < 0))
      throw new Error("--expected-count must be a non-negative integer.");
    const report = await loadTrustReport(path.resolve(result));
    const problems = storedReportProblems(report, config);
    if (problems.length)
      throw new Error(
        `Refusing to audit an invalid signed report:\n${problems.map((item) => `- ${item}`).join("\n")}`,
      );
    const entry = await appendAuditJournal(path.resolve(options.journal), config, report, {
      ...(expectedHead ? { headSha256: expectedHead } : {}),
      ...(expectedCount !== undefined ? { count: expectedCount } : {}),
    });
    console.log(pc.green(`Appended audit record ${entry.sequence} for ${report.run_id}.`));
    console.log(`Head: ${entry.entry_sha256}`);
    console.log(`Journal: ${path.resolve(options.journal)}`);
  });

cli
  .command("audit:verify [journal]", "Verify a hash-chained audit journal and its signed reports")
  .option("--config <file>", "Current trust configuration", { default: "trust.yaml" })
  .option(
    "--policy <file>",
    "Additional historical policy file used as a trust root; repeat when needed",
  )
  .option("--expected-head <digest>", "Externally anchored audit head digest")
  .option("--expected-count <count>", "Externally anchored audit record count")
  .action(async (journal = ".trust/audit/reports.jsonl", options) => {
    const currentConfig = await loadTrustConfig(path.resolve(options.config));
    const policies = [
      currentConfig,
      ...(await Promise.all(
        values(options.policy).map((file) => loadTrustConfig(path.resolve(file))),
      )),
    ];
    const policiesByDigest = new Map(policies.map((policy) => [sha256(policy), policy]));
    const validation = parseAuditJournal(await readFile(path.resolve(journal), "utf8"));
    const problems = [...validation.problems];
    for (const entry of validation.entries) {
      const policy = policiesByDigest.get(entry.policy_sha256);
      if (!policy)
        problems.push(
          `Audit record ${entry.sequence} has no matching trusted policy file for digest ${entry.policy_sha256}.`,
        );
      else
        for (const problem of storedReportProblems(entry.report, policy))
          problems.push(`Audit record ${entry.sequence}: ${problem}`);
      if (
        entry.report.attestation &&
        new Date(entry.recorded_at).getTime() <
          new Date(entry.report.attestation.signed_at).getTime()
      )
        problems.push(`Audit record ${entry.sequence} predates its report attestation.`);
    }
    if (
      options.expectedHead !== undefined &&
      String(options.expectedHead) !== validation.headSha256
    )
      problems.push("The audit journal head does not match the external checkpoint.");
    if (options.expectedCount !== undefined) {
      const expectedCount = Number(options.expectedCount);
      if (!Number.isInteger(expectedCount) || expectedCount < 0)
        throw new Error("--expected-count must be a non-negative integer.");
      if (validation.entries.length !== expectedCount)
        problems.push(
          `The audit journal has ${validation.entries.length} record(s), expected ${expectedCount}.`,
        );
    }
    console.log(pc.bold("TRUST AUDIT VERIFY"));
    console.log(`Records: ${validation.entries.length}`);
    console.log(`Head: ${validation.headSha256 ?? "empty"}`);
    if (problems.length) {
      for (const problem of problems) console.log(pc.red(`✗ ${problem}`));
      process.exitCode = 1;
    } else
      console.log(pc.green("✓ Audit chain, trust roots, semantics, and signatures are valid."));
  });

cli
  .command("report:attest <result>", "Attest a completed report with a trusted signer")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--key <file>", "Ed25519 private key")
  .option("--key-env <name>", "Environment variable containing the Ed25519 private key")
  .option("--signer <id>", "Trusted reporter identity")
  .option("--signer-executable <file>", "External Ed25519 signer executable")
  .option("--signer-arg <value>", "External signer argument; repeat for multiple arguments")
  .option("--signer-env <names>", "Comma-separated environment variables passed only to signer")
  .option("--signer-timeout-ms <milliseconds>", "External signer timeout", { default: 30_000 })
  .option("--expected-policy-sha256 <digest>", "Out-of-band trusted policy digest")
  .option("--require-trusted", "Fail unless attestation produces a trusted verdict")
  .option("--output <file>", "Output report JSON; defaults to the input")
  .action(async (result, options) => {
    const signerId = String(options.signer ?? "").trim();
    const privateKeyPem = await privateKeyFrom(options.key, options.keyEnv);
    const signerExecutable = options.signerExecutable
      ? String(options.signerExecutable)
      : undefined;
    if (!signerId || Boolean(privateKeyPem) === Boolean(signerExecutable))
      throw new Error(
        "--signer and exactly one signing method (--key, --key-env, or --signer-executable) are required.",
      );
    const signerTimeoutMs = Number(options.signerTimeoutMs);
    if (!Number.isInteger(signerTimeoutMs) || signerTimeoutMs < 1 || signerTimeoutMs > 300_000)
      throw new Error("--signer-timeout-ms must be an integer from 1 through 300000.");
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const currentPolicyDigest = sha256(config);
    if (
      options.expectedPolicySha256 !== undefined &&
      String(options.expectedPolicySha256) !== currentPolicyDigest
    )
      throw new Error(
        "The current repository policy does not match the expected trust-root digest.",
      );
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    if (privateKeyPem && !trustedReporterMatchesPrivateKey(config, signerId, privateKeyPem))
      throw new Error(
        `The private key does not match trusted reporter ${JSON.stringify(signerId)}.`,
      );
    const report = await loadTrustReport(path.resolve(result));
    if (report.attestation) throw new Error("The report is already attested.");
    if (report.provenance.digests.policy_sha256 !== currentPolicyDigest)
      throw new Error("The report was produced under a different repository policy.");
    if (report.provenance.digests.contract_sha256 !== sha256(report.contract))
      throw new Error("The embedded contract does not match its recorded digest.");
    if (report.provenance.digests.plan_sha256 !== sha256(report.plan))
      throw new Error("The embedded plan does not match its recorded digest.");
    if (
      report.provenance.digests.change_set_sha256 !==
      (await changeSetDigest(repositoryRoot, report.plan.changed_files))
    )
      throw new Error("The current changed-file contents do not match the report snapshot.");
    const identity = await currentGitIdentity(repositoryRoot);
    if (
      report.provenance.repository.head_sha &&
      report.provenance.repository.head_sha !== identity.headSha
    )
      throw new Error("The current Git HEAD does not match the report provenance.");
    const contractReview = reviewContract(report.contract, config);
    if (!contractReview.valid)
      throw new Error(
        `The embedded contract is invalid:\n${contractReview.blockingIssues.map((item) => `- ${item}`).join("\n")}`,
      );
    const attestationEvidence = report.evidence.find((item) => item.id === "report-attestation");
    if (attestationEvidence) {
      attestationEvidence.status = "verified";
      attestationEvidence.summary = `Report was attested by trusted signer ${signerId}.`;
      delete attestationEvidence.reason;
    } else
      report.evidence.push({
        id: "report-attestation",
        source_id: "report-attestation",
        category: "plan",
        status: "verified",
        summary: `Report was attested by trusted signer ${signerId}.`,
      });
    report.verdict = computeVerdict(report.evidence);
    const semanticProblems = validateReportSemantics(report, config);
    if (semanticProblems.length)
      throw new Error(
        `The report is not semantically valid:\n${semanticProblems.map((item) => `- ${item}`).join("\n")}`,
      );
    report.learning_proposals = proposeLearnings(report);
    report.assurance = { level: "attested" };
    report.attestation = privateKeyPem
      ? createReportAttestation(report, signerId, privateKeyPem)
      : await createExternalAttestation(
          report,
          signerId,
          signerExecutable!,
          values(options.signerArg),
          list(options.signerEnv),
          signerTimeoutMs,
        );
    const attestationProblem = verifyReportAttestation(report, config);
    if (attestationProblem) {
      delete report.attestation;
      throw new Error(`Report attestation was rejected: ${attestationProblem}`);
    }
    const output = path.resolve(options.output ?? result);
    await writeTextFile(path.join(path.dirname(output), "report.md"), renderMarkdownReport(report));
    await writeTextFile(
      path.join(path.dirname(output), "report.txt"),
      renderTerminalReport(report),
    );
    await writeJsonFile(output, report);
    await publishGitHubReport(report, output);
    console.log(pc.green(`Attested ${output} as ${signerId}`));
    if (options.requireTrusted && report.verdict !== "trusted") {
      console.error(pc.red(`A trusted verdict is required; this report is ${report.verdict}.`));
      process.exitCode = 1;
    }
  });

cli
  .command("report <result>", "Render a saved verification result")
  .option("--format <format>", "terminal, markdown, or json", { default: "terminal" })
  .action(async (result, options) => {
    const report = await loadTrustReport(path.resolve(result));
    if (options.format === "markdown") process.stdout.write(renderMarkdownReport(report));
    else if (options.format === "json")
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(renderTerminalReport(report));
  });

cli
  .command("explain [evidence]", "Explain the latest verdict or one evidence result")
  .option("--report <file>", "Report JSON", { default: ".trust/runs/latest/report.json" })
  .option("--format <format>", "terminal or json", { default: "terminal" })
  .action(async (evidenceId, options) => {
    const format = formatFrom(options.format, ["terminal", "json"]);
    const reportFile = path.resolve(options.report);
    const report = await loadTrustReport(reportFile);
    if (!evidenceId) {
      process.stdout.write(
        format === "json" ? `${JSON.stringify(report, null, 2)}\n` : renderTerminalReport(report),
      );
      return;
    }
    const requested = String(evidenceId);
    const matches = report.evidence.filter(
      (item) => item.id === requested || item.source_id === requested,
    );
    if (!matches.length)
      throw new Error(
        `No evidence matched ${JSON.stringify(requested)}. Run trust explain to list all results.`,
      );
    if (format === "json") {
      console.log(
        JSON.stringify(
          { version: 1, report: reportFile, query: requested, evidence: matches },
          null,
          2,
        ),
      );
      return;
    }
    console.log(pc.bold(`TRUST EXPLAIN — ${requested}`));
    for (const item of matches) {
      console.log(`\n${item.status.toUpperCase()} · ${item.id}`);
      console.log(item.summary);
      if (item.reason) console.log(`Reason: ${item.reason}`);
      if (item.command) console.log(`Command: ${item.command}`);
      if (item.duration_ms !== undefined) console.log(`Duration: ${item.duration_ms} ms`);
      if (item.measurements && Object.keys(item.measurements).length)
        console.log(`Measurements: ${JSON.stringify(item.measurements, null, 2)}`);
      if (item.artifacts?.length) console.log(`Artifacts: ${item.artifacts.join(", ")}`);
      if (item.stderr) console.log(`Error output:\n${item.stderr}`);
    }
  });

cli
  .command("learn <result>", "Propose human-approved improvements from verification evidence")
  .option("--output <file>", "Optional YAML output")
  .action(async (result, options) => {
    const report = trustReportSchema.parse(
      JSON.parse(await readFile(path.resolve(result), "utf8")),
    );
    const proposal = {
      version: 1,
      source_run: report.run_id,
      approval: { status: "proposed" },
      proposals: proposeLearnings(report),
    };
    if (options.output) await writeYamlFile(path.resolve(options.output), proposal);
    process.stdout.write(YAML.stringify(proposal));
  });

cli
  .command("learn-incident <incident>", "Propose improvements from a production incident model")
  .option("--output <file>", "Optional YAML output")
  .action(async (incidentFile, options) => {
    const incident = incidentSchema.parse(
      YAML.parse(await readFile(path.resolve(incidentFile), "utf8")),
    );
    const proposal = {
      version: 1,
      source_incident: incident.title,
      approval: { status: "proposed" },
      proposals: proposeFromIncident(incident),
    };
    if (options.output) await writeYamlFile(path.resolve(options.output), proposal);
    process.stdout.write(YAML.stringify(proposal));
  });

cli.usage("[command] [options]");
cli.example('trust --intent "Users can reset their password safely"');
cli.example("trust status");
cli.help((sections) => {
  const commandIndex = sections.findIndex((section) => section.title === "Commands");
  if (commandIndex === -1) return sections;
  const everydayCommands = {
    title: "Everyday workflow",
    body: [
      '  trust --intent "<outcome>"  Verify the current change',
      "  trust status                See state and one recommended next step",
      "  trust enable github         Add protected CI after a trusted local run",
      "  trust try                   See the bundled broken-versus-fixed proof",
      "",
      "That is the complete everyday workflow.",
      "Run trust --help --all only when you need policy, authority, or report internals.",
      "Automation: add --format json to trust --intent or trust status.",
    ].join("\n"),
  };
  const groupedCommands = [
    {
      title: "Core workflow",
      body: [
        "  try                    Show the bundled proof",
        "  status [repository]    Show state and the best next action",
        "  start [repository]     Verify a change from one intent sentence",
        "  inspect [repository]   Inspect discovery and the verification graph",
        "  doctor                 Check readiness for an assurance level",
        "  plan <contract>        Preview selected evidence",
        "  verify                 Execute evidence and produce reports",
        "  explain [evidence]     Explain a verdict or evidence result",
      ].join("\n"),
    },
    {
      title: "Policy and contracts",
      body: [
        "  init [repository]           Write discovered policy",
        "  setup [repository]          Create strict policy and authority keys",
        "  contract:init [output]      Create a draft contract",
        "  contract:approve <file>     Approve and optionally sign a contract",
        "  policy:digest               Print the policy trust root",
        "  schema:export [directory]   Export editor and automation schemas",
      ].join("\n"),
    },
    {
      title: "Authority and CI",
      body: [
        "  enable github               Upgrade local setup to protected CI",
        "  ci:init [output]            Generate the isolated GitHub workflow",
        "  authority:keygen [prefix]   Generate an Ed25519 identity",
        "  authority:register <key>    Register an authority identity",
        "  authority:list              Inspect identity lifecycle state",
        "  authority:revoke <id>       Revoke an authority identity",
      ].join("\n"),
    },
    {
      title: "Reports and learning",
      body: [
        "  report <result>             Render a stored report",
        "  report:verify <result>      Verify report integrity and authority",
        "  report:attest <result>      Attest in a separate trust context",
        "  reports:prune [directory]   Retain bounded local history",
        "  audit:append <result>       Append to the audit chain",
        "  audit:verify [journal]      Verify the audit chain",
        "  learn <result>              Propose evidence-driven improvements",
        "  learn-incident <incident>   Propose incident-driven improvements",
      ].join("\n"),
    },
  ];
  const before = sections.slice(0, commandIndex);
  const after = sections
    .slice(commandIndex + 1)
    .filter((section) => !section.title?.startsWith("For more info"));
  return process.argv.includes("--all")
    ? [...before, everydayCommands, ...groupedCommands, ...after]
    : [...before, everydayCommands, ...after];
});
cli.version(TRUST_VERSION);

try {
  const arguments_ = process.argv.slice(2);
  const rootOnlyOptions = new Set(["--help", "-h", "--version", "-v", "--all"]);
  if (arguments_.length === 1 && arguments_[0] === "--all") process.argv.push("--help");
  if (
    arguments_.length === 0 ||
    (arguments_.some((argument) => argument === "--intent") &&
      !arguments_.some((argument) => cli.commands.some((command) => command.name === argument))) ||
    (arguments_[0]?.startsWith("-") &&
      arguments_.some((argument) => !rootOnlyOptions.has(argument)))
  )
    process.argv.splice(2, 0, "start");
  const parsed = cli.parse(process.argv, { run: false });
  if (!cli.matchedCommand && parsed.args[0] && !parsed.options.help && !parsed.options.version) {
    const unknown = String(parsed.args[0]);
    const suggestion = commandSuggestion(unknown);
    throw new Error(
      `Unknown command ${JSON.stringify(unknown)}.${suggestion ? ` Did you mean ${JSON.stringify(suggestion)}?` : ""} Run trust --help to see available commands.`,
    );
  }
  await cli.runMatchedCommand();
} catch (error) {
  const message = friendlyErrorMessage(error);
  console.error(pc.red(`Error: ${message}`));
  if (process.env.TRUST_DEBUG === "1" && error instanceof Error && error.stack)
    console.error(pc.dim(error.stack));
  process.exitCode = 1;
}
