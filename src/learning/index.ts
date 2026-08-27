import type { Incident, TrustReport } from "../core/index.js";

export interface LearningProposal {
  type: "knowledge" | "qa-heuristic" | "lint" | "regression-test" | "architectural-invariant";
  description: string;
  source_evidence: string;
}

export function proposeLearnings(report: TrustReport): LearningProposal[] {
  const proposals: LearningProposal[] = [];
  for (const item of report.evidence.filter((evidence) => evidence.status === "failed")) {
    if (item.category === "qa" || item.category === "device") {
      proposals.push(
        {
          type: "qa-heuristic",
          description: `Retain the scenario “${item.summary}” in future intent-derived QA missions.`,
          source_evidence: item.id,
        },
        {
          type: "regression-test",
          description: `Add a deterministic regression test covering: ${item.summary}`,
          source_evidence: item.id,
        },
      );
    } else if (item.category === "invariant") {
      proposals.push({
        type: "architectural-invariant",
        description: `Review and, if approved, codify the boundary exposed by ${item.id}.`,
        source_evidence: item.id,
      });
    } else {
      proposals.push({
        type: "regression-test",
        description: `Preserve the failure detected by ${item.id} as a focused regression test.`,
        source_evidence: item.id,
      });
    }
  }
  for (const unknown of report.unknowns) {
    proposals.push({
      type: "knowledge",
      description: `Document how to verify: ${unknown}`,
      source_evidence: "unknown",
    });
  }
  return deduplicate(proposals);
}

export function proposeFromIncident(incident: Incident): LearningProposal[] {
  return deduplicate([
    {
      type: "regression-test",
      description: `Add a regression test for incident: ${incident.title}. Cause: ${incident.cause}`,
      source_evidence: `incident:${incident.title}`,
    },
    {
      type: "qa-heuristic",
      description: `Exercise ${incident.affected_surfaces.join(", ") || "the affected journey"} under the conditions from: ${incident.title}.`,
      source_evidence: `incident:${incident.title}`,
    },
    {
      type: "knowledge",
      description: `Record the domain failure mode: ${incident.cause}`,
      source_evidence: `incident:${incident.title}`,
    },
  ]);
}

function deduplicate<T extends { type: string; description: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [`${item.type}:${item.description}`, item])).values()];
}
