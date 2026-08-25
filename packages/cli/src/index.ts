#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { cac } from "cac";
import pc from "picocolors";
import YAML from "yaml";
import { incidentSchema, trustReportSchema } from "../../core/src/index.js";
import {
  loadChangeContract,
  loadTrustConfig,
  loadTrustReport,
  writeJsonFile,
  writeYamlFile,
} from "../../core/src/files.js";
import { verifyChange } from "../../core/src/verify.js";
import { contractSummary, reviewContract } from "../../contracts/src/index.js";
import { discoverRepository } from "../../discovery/src/index.js";
import { renderDiscovery } from "../../discovery/src/render.js";
import { buildVerificationGraph, createVerificationPlan } from "../../graph/src/index.js";
import { proposeFromIncident, proposeLearnings } from "../../learning/src/index.js";
import { renderMarkdownReport, renderTerminalReport } from "../../reporters/src/index.js";

const cli = cac("trust");
const list = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap((item) => String(item).split(",")).filter(Boolean);
  if (typeof value === "string") return value.split(",").filter(Boolean);
  return [];
};

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
  .command("doctor", "Validate configuration, evidence references, and local adapter readiness")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--contract <file>", "Optional change contract")
  .action(async (options) => {
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    const problems: string[] = [];
    for (const verifier of config.verifiers) {
      if (verifier.kind === "agent-browser" || verifier.kind === "agent-device") {
        const adapter = path.resolve(repositoryRoot, verifier.adapter);
        try {
          await access(adapter);
        } catch {
          problems.push(`${verifier.id}: missing adapter ${adapter}`);
        }
      }
      if (verifier.kind === "playwright" && verifier.executable.includes("/")) {
        const executable = path.resolve(repositoryRoot, verifier.cwd, verifier.executable);
        try {
          await access(executable);
        } catch {
          problems.push(`${verifier.id}: missing executable ${executable}`);
        }
      }
    }
    if (options.contract) {
      const contract = await loadChangeContract(path.resolve(options.contract));
      const known = new Set([
        ...config.checks.map((item) => item.id),
        ...config.invariants.map((item) => item.id),
        ...config.verifiers.map((item) => item.id),
        ...(config.qa.enabled ? ["qa", "preview-qa"] : []),
      ]);
      for (const required of contract.required_evidence)
        if (!known.has(required)) problems.push(`contract requires unknown evidence ${required}`);
    }
    console.log(pc.bold(`TRUST DOCTOR — ${config.repository.name}`));
    console.log(`Checks: ${config.checks.length}`);
    console.log(`Invariants: ${config.invariants.length}`);
    console.log(
      `Verifiers: ${config.verifiers.map((item) => `${item.id} (${item.kind})`).join(", ") || "none"}`,
    );
    console.log(`Surfaces: ${config.surfaces.length}`);
    if (problems.length) {
      for (const problem of problems) console.log(pc.red(`✗ ${problem}`));
      process.exitCode = 1;
    } else console.log(pc.green("✓ Configuration and local adapter references are ready."));
  });

cli
  .command(
    "inspect [repository]",
    "Inspect discovery and optionally render a configured verification graph",
  )
  .option("--config <file>", "Existing trust configuration")
  .action(async (repository = ".", options) => {
    const report = await discoverRepository(repository);
    process.stdout.write(renderDiscovery(report));
    if (options.config) {
      const config = await loadTrustConfig(path.resolve(options.config));
      console.log(pc.bold("\nVerification graph:"));
      for (const node of buildVerificationGraph(config)) {
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
  .option("--output <file>", "Plan JSON output", { default: ".trust/plan.json" })
  .action(async (contractFile, options) => {
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(path.resolve(contractFile));
    const review = reviewContract(contract);
    console.log(contractSummary(contract));
    for (const warning of review.warnings) console.log(pc.yellow(`! ${warning}`));
    for (const issue of review.blockingIssues) console.log(pc.red(`✗ ${issue}`));
    const plan = createVerificationPlan(config, contract, list(options.changed));
    await writeJsonFile(path.resolve(options.output), plan);
    console.log(`\nSelected: ${plan.selected_checks.join(", ") || "no checks"}`);
    console.log(`Invariants: ${plan.selected_invariants.join(", ") || "none"}`);
    console.log(`Verifiers: ${plan.selected_verifiers.join(", ") || "none"}`);
    console.log(`QA: ${plan.qa_required ? "required" : "not required"}`);
    if (!review.valid) process.exitCode = 2;
  });

cli
  .command("verify", "Execute selected evidence and produce terminal, JSON, and Markdown reports")
  .option("--config <file>", "Trust configuration", { default: "trust.yaml" })
  .option("--contract <file>", "Approved change contract", { default: "change-contract.yaml" })
  .option("--changed <files>", "Comma-separated changed files")
  .option("--preview-url <url>", "Running application preview URL")
  .option("--output <directory>", "Evidence output directory", { default: ".trust/runs/latest" })
  .action(async (options) => {
    const configFile = path.resolve(options.config);
    const config = await loadTrustConfig(configFile);
    const contract = await loadChangeContract(path.resolve(options.contract));
    const repositoryRoot = path.resolve(path.dirname(configFile), config.repository.root);
    const outputDirectory = path.resolve(options.output);
    const report = await verifyChange({
      config,
      contract,
      repositoryRoot,
      changedFiles: list(options.changed),
      outputDirectory,
      ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
    });
    process.stdout.write(renderTerminalReport(report));
    if (report.verdict !== "trusted") process.exitCode = 1;
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

cli.help();
cli.version("0.1.0");

try {
  cli.parse();
} catch (error) {
  console.error(pc.red(error instanceof Error ? (error.stack ?? error.message) : String(error)));
  process.exitCode = 1;
}
