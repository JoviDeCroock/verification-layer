import type { ChangeContract, TrustConfig } from "../../core/src/index.js";
import { approvalDigest } from "../../core/src/provenance.js";
import { verifyContractSignature } from "../../core/src/attestations.js";

export interface ContractReview {
  valid: boolean;
  blockingIssues: string[];
  warnings: string[];
}

export function reviewContract(
  contract: ChangeContract,
  config?: TrustConfig,
  now = new Date(),
): ContractReview {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  if (contract.approval.status !== "approved")
    blockingIssues.push("The change contract has not been approved.");
  if (
    contract.approval.approved_at &&
    new Date(contract.approval.approved_at).getTime() > now.getTime()
  )
    blockingIssues.push("The contract approval timestamp is in the future.");
  if (contract.approval.status === "approved") {
    if (!contract.approval.content_sha256)
      blockingIssues.push("The approved contract is not bound to a content digest.");
    else if (contract.approval.content_sha256 !== approvalDigest(contract))
      blockingIssues.push("The contract content changed after approval.");
  }
  if (!contract.affected_surfaces.length)
    blockingIssues.push("At least one affected surface must be declared.");
  if (!contract.required_evidence.length)
    blockingIssues.push("At least one evidence source must be explicitly required.");
  if (!contract.risks.length)
    warnings.push("No risks were declared; risk-derived QA will be limited.");
  const behaviorIds = contract.expected_behaviors.map((behavior) => behavior.id);
  for (const id of new Set(behaviorIds))
    if (behaviorIds.filter((candidate) => candidate === id).length > 1)
      blockingIssues.push(`Behavior ID ${JSON.stringify(id)} is declared more than once.`);
  if (config) {
    if (contract.approval.status === "approved") {
      const signatureProblem = verifyContractSignature(contract, config);
      if (signatureProblem) blockingIssues.push(signatureProblem);
    }
    const surfaceIds = new Set(config.surfaces.map((surface) => surface.id));
    for (const surface of contract.affected_surfaces)
      if (!surfaceIds.has(surface))
        blockingIssues.push(`Affected surface ${JSON.stringify(surface)} is not configured.`);
    const evidenceIds = new Set([
      ...config.checks.map((item) => item.id),
      ...config.invariants.map((item) => item.id),
      ...config.verifiers.map((item) => item.id),
      ...(config.qa.enabled ? ["qa", "preview-qa"] : []),
    ]);
    for (const required of contract.required_evidence)
      if (!evidenceIds.has(required))
        blockingIssues.push(`Required evidence ${JSON.stringify(required)} is not configured.`);
    for (const behavior of contract.expected_behaviors) {
      for (const evidence of behavior.evidence) {
        const sourceId = evidence.split("#", 1)[0]!;
        if (!evidenceIds.has(sourceId))
          blockingIssues.push(
            `Behavior ${JSON.stringify(behavior.id)} references unknown evidence ${JSON.stringify(evidence)}.`,
          );
        if (!contract.required_evidence.includes(sourceId))
          blockingIssues.push(
            `Behavior ${JSON.stringify(behavior.id)} evidence source ${JSON.stringify(sourceId)} is not listed in required_evidence.`,
          );
      }
    }
  }
  return { valid: blockingIssues.length === 0, blockingIssues, warnings };
}

export function contractSummary(contract: ChangeContract): string {
  return [
    `Intent: ${contract.intent}`,
    `Approval: ${contract.approval.status}`,
    `Authority: ${contract.approval.method ?? "missing"}${contract.approval.key_id ? ` (${contract.approval.key_id})` : ""}`,
    `Behaviors: ${contract.expected_behaviors.map((behavior) => behavior.id).join(", ")}`,
    `Surfaces: ${contract.affected_surfaces.join(", ") || "inferred"}`,
    `Risks: ${contract.risks.join(", ") || "none declared"}`,
    `Required evidence: ${contract.required_evidence.join(", ") || "none declared"}`,
  ].join("\n");
}
