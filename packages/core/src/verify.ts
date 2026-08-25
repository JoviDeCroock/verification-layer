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
import { reviewContract } from "../../contracts/src/index.js";
import {
  approvalDigest,
  changeSetDigest,
  collectProvenance,
  currentGitIdentity,
  validateChangedFiles,
} from "./provenance.js";
import {
  createReportAttestation,
  trustedReporterMatchesPrivateKey,
  verifyContractSignature,
} from "./attestations.js";
import { redactEvidence } from "./redaction.js";
import { deriveClaimEvidence } from "./report-validation.js";

export interface VerifyInput {
  config: TrustConfig;
  contract: ChangeContract;
  repositoryRoot: string;
  changedFiles: string[];
  outputDirectory: string;
  previewUrl?: string;
  changedFilesSource?: "git" | "explicit";
  baseSha?: string;
  reportSigner?: { id: string; privateKeyPem: string };
  signal?: AbortSignal;
}

export async function verifyChange(input: VerifyInput): Promise<TrustReport> {
  input.signal?.throwIfAborted();
  validateChangedFiles(input.repositoryRoot, input.changedFiles);
  const [initialChangeSetDigest, initialRepositoryIdentity] = await Promise.all([
    changeSetDigest(input.repositoryRoot, input.changedFiles),
    currentGitIdentity(input.repositoryRoot),
  ]);
  const plan = createVerificationPlan(input.config, input.contract, input.changedFiles);
  const contractReview = reviewContract(input.contract, input.config);
  const approvalSignatureProblem = verifyContractSignature(input.contract, input.config);
  const approvalValid =
    input.contract.approval.status === "approved" &&
    Boolean(input.contract.approval.approved_by) &&
    Boolean(input.contract.approval.approved_at) &&
    input.contract.approval.content_sha256 === approvalDigest(input.contract) &&
    !approvalSignatureProblem &&
    new Date(input.contract.approval.approved_at!).getTime() <= Date.now();
  const reportSigningRequired = input.config.authority?.require_signed_reports !== false;
  const reportSignerReady = Boolean(
    input.reportSigner &&
    trustedReporterMatchesPrivateKey(
      input.config,
      input.reportSigner.id,
      input.reportSigner.privateKeyPem,
    ),
  );
  const changedFilesSource = input.changedFilesSource ?? "explicit";
  const changeSetAuthorityValid =
    (changedFilesSource === "git" && Boolean(initialRepositoryIdentity.headSha)) ||
    (changedFilesSource === "explicit" &&
      input.config.repository.allow_explicit_changed_files === true);
  const evidence: Evidence[] = [
    {
      id: "change-contract-approval",
      source_id: "change-contract-approval",
      category: "plan",
      status: approvalValid ? "verified" : "failed",
      summary: approvalValid
        ? `Change contract was approved by ${input.contract.approval.approved_by} before verification.`
        : `Change contract approval is invalid${approvalSignatureProblem ? `: ${approvalSignatureProblem}` : "."}`,
    },
    {
      id: "change-set-authority",
      source_id: "change-set-authority",
      category: "plan",
      status: changeSetAuthorityValid ? "verified" : "not_verified",
      summary:
        changedFilesSource === "git" && initialRepositoryIdentity.headSha
          ? `Changed files were derived from Git at ${initialRepositoryIdentity.headSha}.`
          : changedFilesSource === "git"
            ? "Git-derived changes have no resolvable HEAD commit."
            : input.config.repository.allow_explicit_changed_files === true
              ? "Repository policy allows an explicit fixture change set."
              : "Explicit changed files are not authorized by repository policy.",
      ...(changeSetAuthorityValid
        ? {}
        : {
            reason:
              "Use a committed Git repository and Git-derived changes, or explicitly enable fixture change sets in repository policy.",
          }),
    },
    {
      id: "change-set-presence",
      source_id: "change-set-presence",
      category: "plan",
      status: input.changedFiles.length ? "verified" : "not_verified",
      summary: input.changedFiles.length
        ? `The change set contains ${input.changedFiles.length} canonical repository-relative path(s).`
        : "The change set is empty.",
      ...(input.changedFiles.length
        ? {}
        : { reason: "A change verification run must identify at least one changed file." }),
    },
    {
      id: "report-attestation",
      source_id: "report-attestation",
      category: "plan",
      status: reportSignerReady
        ? "verified"
        : reportSigningRequired
          ? "not_verified"
          : input.reportSigner
            ? "failed"
            : "not_applicable",
      summary: reportSignerReady
        ? `Report will be attested by trusted signer ${input.reportSigner!.id}.`
        : reportSigningRequired
          ? "Repository policy requires a trusted report attestation."
          : input.reportSigner
            ? "The supplied report signing key is not trusted by repository policy."
            : "Repository policy does not require report attestation.",
      ...(reportSignerReady || (!reportSigningRequired && !input.reportSigner)
        ? {}
        : {
            reason:
              "Pass --report-key and --report-signer for a key registered in authority.trusted_reporters.",
          }),
    },
    {
      id: "contract-policy",
      source_id: "contract-policy",
      category: "plan",
      status: contractReview.valid ? "verified" : "failed",
      summary: contractReview.valid
        ? "Change contract is complete and resolves against repository policy."
        : `Change contract is invalid: ${contractReview.blockingIssues.join(" ")}`,
    },
  ];

  const selectedSourceIds = [
    ...plan.selected_checks,
    ...plan.selected_invariants,
    ...plan.selected_verifiers,
    ...(plan.qa_required ? ["qa"] : []),
  ];
  if (!selectedSourceIds.length)
    evidence.push({
      id: "verification-plan-coverage",
      source_id: "verification-plan-coverage",
      category: "plan",
      status: "not_verified",
      summary: "The verification plan selected no executable evidence.",
      reason: "A change cannot be trusted from approval alone.",
    });

  const verifierResult = contractReview.valid
    ? await runSelectedVerifiers(
        input.config,
        plan,
        input.contract,
        input.repositoryRoot,
        input.outputDirectory,
        input.previewUrl,
        input.signal,
      )
    : { evidence: [], missions: [] };
  if (contractReview.valid) {
    evidence.push(
      ...(await runSelectedChecks(input.config, plan, input.repositoryRoot, input.signal)),
    );
    input.signal?.throwIfAborted();
    evidence.push(
      ...(await runSelectedInvariants(input.config, plan, input.repositoryRoot, input.signal)),
    );
    input.signal?.throwIfAborted();
    evidence.push(...verifierResult.evidence);
  }
  const qa =
    contractReview.valid && plan.qa_required
      ? await runQa(
          input.config,
          input.contract,
          input.repositoryRoot,
          input.outputDirectory,
          input.previewUrl,
          { sourceId: "qa", ...(input.signal ? { signal: input.signal } : {}) },
        )
      : { missions: [], evidence: [] };
  evidence.push(...qa.evidence);
  input.signal?.throwIfAborted();
  const [finalChangeSetDigest, finalRepositoryIdentity] = await Promise.all([
    changeSetDigest(input.repositoryRoot, input.changedFiles),
    currentGitIdentity(input.repositoryRoot),
  ]);
  const changeSetStable = finalChangeSetDigest === initialChangeSetDigest;
  evidence.push({
    id: "change-set-stability",
    source_id: "change-set-stability",
    category: "plan",
    status: changeSetStable ? "verified" : "failed",
    summary: changeSetStable
      ? "Changed-file contents remained stable throughout evidence execution."
      : "Changed-file contents changed during evidence execution.",
    ...(changeSetStable
      ? {}
      : { reason: "The report cannot attest a moving repository snapshot." }),
  });
  const headStable = finalRepositoryIdentity.headSha === initialRepositoryIdentity.headSha;
  evidence.push({
    id: "repository-head-stability",
    source_id: "repository-head-stability",
    category: "plan",
    status: headStable ? "verified" : "failed",
    summary: headStable
      ? "Git HEAD remained stable throughout evidence execution."
      : "Git HEAD changed during evidence execution.",
    ...(headStable ? {} : { reason: "The report cannot attest evidence executed across commits." }),
  });

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
      source_id: unknown.match(/“([^”]+)/)?.[1] ?? "evidence",
      category: "plan",
      status: "not_verified",
      summary: unknown,
      reason: "The approved contract names evidence the repository cannot currently produce.",
    });
  }
  for (const sourceId of selectedSourceIds) {
    if (evidence.some((item) => (item.source_id ?? item.id) === sourceId)) continue;
    evidence.push({
      id: `missing-result:${sourceId}`,
      source_id: sourceId,
      category: "plan",
      status: "not_verified",
      summary: `Selected evidence ${JSON.stringify(sourceId)} produced no result.`,
      reason: "Every selected evidence source must produce at least one structured result.",
    });
  }

  evidence.push(...deriveClaimEvidence(input.contract, evidence));
  const unknowns = [
    ...contractReview.blockingIssues,
    ...missingEvidence,
    ...input.contract.excluded.map((entry) => `${entry.item} was not verified: ${entry.reason}`),
  ];

  const provenance = await collectProvenance({
    config: input.config,
    contract: input.contract,
    plan,
    repositoryRoot: input.repositoryRoot,
    changedFilesSource,
    repositoryIdentity: initialRepositoryIdentity,
    changeSetSha256: initialChangeSetDigest,
    ...(input.baseSha ? { baseSha: input.baseSha } : {}),
    ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
  });
  const safeEvidence = redactEvidence(evidence, input.config);
  const reportBase: TrustReport = {
    version: 1,
    run_id: `${input.contract.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    created_at: new Date().toISOString(),
    contract: input.contract,
    plan,
    implementation: { changed_files: input.changedFiles.length },
    provenance,
    evidence: safeEvidence,
    qa_missions: [
      ...new Map(
        [...verifierResult.missions, ...qa.missions].map((mission) => [mission.id, mission]),
      ).values(),
    ],
    unknowns,
    learning_proposals: [],
    assurance: {
      level: reportSignerReady ? "attested" : changedFilesSource === "git" ? "local" : "trial",
    },
    verdict: computeVerdict(safeEvidence),
  };
  reportBase.learning_proposals = proposeLearnings(reportBase);
  if (reportSignerReady && input.reportSigner)
    reportBase.attestation = createReportAttestation(
      reportBase,
      input.reportSigner.id,
      input.reportSigner.privateKeyPem,
    );

  await writeTextFile(
    path.join(input.outputDirectory, "report.md"),
    renderMarkdownReport(reportBase),
  );
  await writeTextFile(
    path.join(input.outputDirectory, "report.txt"),
    renderTerminalReport(reportBase),
  );
  // report.json is the completed-run marker used by verification, retention,
  // and artifact consumers, so publish it only after every companion view.
  await writeJsonFile(path.join(input.outputDirectory, "report.json"), reportBase);
  return reportBase;
}
