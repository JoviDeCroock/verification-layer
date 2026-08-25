import type { ChangeContract } from "../../core/src/index.js";

export interface ContractReview {
  valid: boolean;
  blockingIssues: string[];
  warnings: string[];
}

export function reviewContract(contract: ChangeContract): ContractReview {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  if (contract.approval.status !== "approved")
    blockingIssues.push("The change contract has not been approved.");
  if (!contract.affected_surfaces.length)
    warnings.push("No affected surfaces were declared; discovery must rely on changed files.");
  if (!contract.required_evidence.length)
    warnings.push("No evidence IDs were explicitly required.");
  if (!contract.risks.length)
    warnings.push("No risks were declared; risk-derived QA will be limited.");
  return { valid: blockingIssues.length === 0, blockingIssues, warnings };
}

export function contractSummary(contract: ChangeContract): string {
  return [
    `Intent: ${contract.intent}`,
    `Approval: ${contract.approval.status}`,
    `Behaviors: ${contract.expected_behaviors.length}`,
    `Surfaces: ${contract.affected_surfaces.join(", ") || "inferred"}`,
    `Risks: ${contract.risks.join(", ") || "none declared"}`,
    `Required evidence: ${contract.required_evidence.join(", ") || "none declared"}`,
  ].join("\n");
}
