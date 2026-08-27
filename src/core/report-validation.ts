import { isDeepStrictEqual } from "node:util";
import { createVerificationPlan } from "../graph/index.js";
import type { ChangeContract, Evidence, TrustConfig, TrustReport } from "./index.js";
import { computeVerdict } from "./index.js";

function resultMatchesReference(item: Evidence, sourceId: string, resultId?: string): boolean {
  if ((item.source_id ?? item.id) !== sourceId) return false;
  return (
    !resultId ||
    item.id === resultId ||
    item.id.endsWith(`:${resultId}`) ||
    item.id.startsWith(`${resultId}:attempt-`) ||
    item.id.startsWith(`${sourceId}:${resultId}:attempt-`)
  );
}

export function deriveClaimEvidence(contract: ChangeContract, evidence: Evidence[]): Evidence[] {
  const sourceEvidence = evidence.filter((item) => item.category !== "claim");
  return contract.expected_behaviors.map((behavior) => {
    const resultsByReference = behavior.evidence.map((reference) => {
      const [sourceId, resultId] = reference.split("#", 2);
      const results = sourceEvidence.filter((item) =>
        resultMatchesReference(item, sourceId!, resultId),
      );
      return { reference, results };
    });
    const supporting = resultsByReference.flatMap((item) => item.results);
    const missingSources = resultsByReference
      .filter((item) => !item.results.length)
      .map((item) => item.reference);
    const sourceStatus = supporting.some((item) => item.status === "failed")
      ? "failed"
      : missingSources.length || supporting.some((item) => item.status === "not_verified")
        ? "not_verified"
        : supporting.length > 0 && supporting.every((item) => item.status === "verified")
          ? "verified"
          : "not_verified";
    const evidenceMapping = behavior.evidence_mapping ?? "explicit";
    const status =
      sourceStatus === "verified" && evidenceMapping === "inferred" ? "not_verified" : sourceStatus;
    return {
      id: `claim:${behavior.id}`,
      source_id: `claim:${behavior.id}`,
      category: "claim",
      status,
      summary:
        status === "verified"
          ? `Expected behavior verified: ${behavior.description}`
          : sourceStatus === "verified" && evidenceMapping === "inferred"
            ? `Configured evidence passed, but its relationship to the expected behavior was inferred rather than explicitly approved: ${behavior.description}`
            : `Expected behavior was not established: ${behavior.description}`,
      measurements: {
        evidence_sources: behavior.evidence.join(","),
        evidence_mapping: evidenceMapping,
        supporting_results: supporting.length,
        missing_sources: missingSources.join(","),
      },
    };
  });
}

function planContent(report: TrustReport): Omit<TrustReport["plan"], "created_at"> {
  const { created_at: _createdAt, ...content } = report.plan;
  return content;
}

export function validateReportSemantics(report: TrustReport, config: TrustConfig): string[] {
  const problems: string[] = [];
  const evidenceIds = report.evidence.map((item) => item.id);
  for (const id of new Set(evidenceIds))
    if (evidenceIds.filter((candidate) => candidate === id).length > 1)
      problems.push(`Evidence ID ${JSON.stringify(id)} appears more than once.`);

  const expectedPlan = createVerificationPlan(config, report.contract, report.plan.changed_files);
  const { created_at: _createdAt, ...expectedPlanContent } = expectedPlan;
  if (!isDeepStrictEqual(planContent(report), expectedPlanContent))
    problems.push(
      "The embedded verification plan does not match current policy and contract selection.",
    );
  if (report.implementation.changed_files !== new Set(report.plan.changed_files).size)
    problems.push("The implementation changed-file count does not match the verification plan.");

  const selectedSources = [
    ...report.plan.selected_checks,
    ...report.plan.selected_invariants,
    ...report.plan.selected_verifiers,
    ...(report.plan.qa_required ? ["qa"] : []),
  ];
  for (const sourceId of selectedSources)
    if (!report.evidence.some((item) => (item.source_id ?? item.id) === sourceId))
      problems.push(`Selected evidence source ${JSON.stringify(sourceId)} has no report result.`);

  for (const id of [
    "change-contract-approval",
    "change-set-authority",
    "change-set-presence",
    "change-set-stability",
    "repository-head-stability",
    "report-attestation",
    "contract-policy",
  ])
    if (!report.evidence.some((item) => item.id === id))
      problems.push(`Required authority evidence ${JSON.stringify(id)} is missing.`);

  const derivedClaims = deriveClaimEvidence(report.contract, report.evidence);
  const actualClaims = report.evidence.filter((item) => item.category === "claim");
  if (actualClaims.length !== derivedClaims.length)
    problems.push("The report does not contain exactly one claim for every expected behavior.");
  for (const expected of derivedClaims) {
    const actual = actualClaims.find((item) => item.id === expected.id);
    if (!actual || actual.status !== expected.status)
      problems.push(
        `Behavior claim ${JSON.stringify(expected.id)} does not match its source evidence.`,
      );
  }
  const derivedVerdict = computeVerdict([
    ...report.evidence.filter((item) => item.category !== "claim"),
    ...derivedClaims,
  ]);
  if (report.verdict !== derivedVerdict)
    problems.push("The stored verdict does not match independently derived report semantics.");
  const derivedAssurance = report.attestation
    ? "attested"
    : report.provenance.repository.changed_files_source === "git"
      ? "local"
      : "trial";
  if (report.assurance && report.assurance.level !== derivedAssurance)
    problems.push("The stored assurance level does not match report provenance and attestation.");
  return problems;
}
