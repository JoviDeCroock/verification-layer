import path from "node:path";
import type { ChangeContract, Evidence, TrustConfig, TrustReport } from "./index.js";
import { computeVerdict } from "./index.js";
import { writeJsonFile, writeTextFile } from "./files.js";
import { createVerificationPlan } from "../../graph/src/index.js";
import { runSelectedChecks } from "../../runner/src/index.js";
import { runSelectedInvariants } from "../../invariants/src/index.js";
import { runQa } from "../../qa/src/index.js";
import { proposeLearnings } from "../../learning/src/index.js";
import { renderMarkdownReport, renderTerminalReport } from "../../reporters/src/index.js";
import { runSelectedVerifiers } from "../../verifiers/src/index.js";

export interface VerifyInput {
  config: TrustConfig;
  contract: ChangeContract;
  repositoryRoot: string;
  changedFiles: string[];
  outputDirectory: string;
  previewUrl?: string;
}

export async function verifyChange(input: VerifyInput): Promise<TrustReport> {
  const plan = createVerificationPlan(input.config, input.contract, input.changedFiles);
  const evidence: Evidence[] = [
    {
      id: "change-contract-approval",
      category: "plan",
      status: input.contract.approval.status === "approved" ? "verified" : "failed",
      summary:
        input.contract.approval.status === "approved"
          ? "Change contract was approved before verification."
          : "Change contract is not approved.",
    },
  ];

  evidence.push(...(await runSelectedChecks(input.config, plan, input.repositoryRoot)));
  evidence.push(...(await runSelectedInvariants(input.config, plan, input.repositoryRoot)));
  const verifierResult = await runSelectedVerifiers(
    input.config,
    plan,
    input.contract,
    input.repositoryRoot,
    input.outputDirectory,
    input.previewUrl,
  );
  evidence.push(...verifierResult.evidence);
  const qa = plan.qa_required
    ? await runQa(
        input.config,
        input.contract,
        input.repositoryRoot,
        input.outputDirectory,
        input.previewUrl,
      )
    : { missions: [], evidence: [] };
  evidence.push(...qa.evidence);

  const knownEvidence = new Set([
    ...input.config.checks.map((item) => item.id),
    ...input.config.invariants.map((item) => item.id),
    ...input.config.verifiers.map((item) => item.id),
    ...(input.config.qa.enabled ? ["preview-qa", "qa"] : []),
  ]);
  const missingEvidence = input.contract.required_evidence
    .filter((id) => !knownEvidence.has(id))
    .map((id) => `Required evidence “${id}” has no configured verifier.`);
  for (const unknown of missingEvidence) {
    evidence.push({
      id: `missing:${unknown.match(/“([^”]+)/)?.[1] ?? "evidence"}`,
      category: "plan",
      status: "not_verified",
      summary: unknown,
      reason: "The approved contract names evidence the repository cannot currently produce.",
    });
  }
  const unknowns = [
    ...missingEvidence,
    ...input.contract.excluded.map((entry) => `${entry.item} was not verified: ${entry.reason}`),
  ];

  const reportBase: TrustReport = {
    version: 1,
    run_id: `${input.contract.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    created_at: new Date().toISOString(),
    contract: input.contract,
    plan,
    implementation: { changed_files: input.changedFiles.length },
    evidence,
    qa_missions: [
      ...new Map(
        [...verifierResult.missions, ...qa.missions].map((mission) => [mission.id, mission]),
      ).values(),
    ],
    unknowns,
    learning_proposals: [],
    verdict: computeVerdict(evidence),
  };
  reportBase.learning_proposals = proposeLearnings(reportBase);

  await writeJsonFile(path.join(input.outputDirectory, "report.json"), reportBase);
  await writeTextFile(
    path.join(input.outputDirectory, "report.md"),
    renderMarkdownReport(reportBase),
  );
  await writeTextFile(
    path.join(input.outputDirectory, "report.txt"),
    renderTerminalReport(reportBase),
  );
  return reportBase;
}
