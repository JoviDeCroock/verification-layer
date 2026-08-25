import micromatch from "micromatch";
import type { ChangeContract, TrustConfig, VerificationPlan } from "../../core/src/index.js";

function matches(files: string[], patterns: string[]): boolean {
  return patterns.length > 0 && micromatch(files, patterns, { dot: true }).length > 0;
}

function addReason(reasons: Record<string, string[]>, id: string, reason: string): void {
  (reasons[id] ??= []).push(reason);
}

function canonicalTag(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function hasRisk(tags: string[], risks: string[]): string | undefined {
  const normalizedTags = new Set(tags.map(canonicalTag));
  return risks.find((risk) => normalizedTags.has(canonicalTag(risk)));
}

export function createVerificationPlan(
  config: TrustConfig,
  contract: ChangeContract,
  changedFiles: string[],
): VerificationPlan {
  const affected = new Set(contract.affected_surfaces);
  const reasons: Record<string, string[]> = {};

  for (const surface of config.surfaces) {
    if (matches(changedFiles, surface.paths)) {
      affected.add(surface.id);
      addReason(
        reasons,
        `surface:${surface.id}`,
        `changed files matched ${surface.paths.join(", ")}`,
      );
    }
  }

  const queue = [...affected];
  for (let index = 0; index < queue.length; index++) {
    const surfaceId = queue[index]!;
    const surface = config.surfaces.find((item) => item.id === surfaceId);
    if (!surface) continue;
    for (const dependency of surface.depends_on) {
      if (!affected.has(dependency)) {
        affected.add(dependency);
        queue.push(dependency);
      }
      addReason(reasons, `surface:${dependency}`, `dependency of surface ${surfaceId}`);
    }
  }

  const selectedChecks = new Set<string>();
  const selectedInvariants = new Set<string>();
  const selectedVerifiers = new Set<string>();
  const surfaceIds = [...affected];
  for (const surfaceId of surfaceIds) {
    const surface = config.surfaces.find((item) => item.id === surfaceId);
    if (!surface) continue;
    for (const requirement of surface.requires) {
      if (config.checks.some((check) => check.id === requirement)) selectedChecks.add(requirement);
      if (config.invariants.some((invariant) => invariant.id === requirement))
        selectedInvariants.add(requirement);
      if (config.verifiers.some((verifier) => verifier.id === requirement))
        selectedVerifiers.add(requirement);
      addReason(reasons, requirement, `required by surface ${surfaceId}`);
    }
  }

  for (const check of config.checks) {
    if (check.required || matches(changedFiles, check.scope)) {
      selectedChecks.add(check.id);
      addReason(
        reasons,
        check.id,
        check.required ? "repository-required check" : "changed files matched check scope",
      );
    }
    const matchedRisk = hasRisk(check.tags, contract.risks);
    if (matchedRisk) {
      selectedChecks.add(check.id);
      addReason(reasons, check.id, `selected for contract risk ${matchedRisk}`);
    }
  }

  for (const invariant of config.invariants) {
    if (matches(changedFiles, invariant.scope)) {
      selectedInvariants.add(invariant.id);
      addReason(reasons, invariant.id, "changed files matched invariant scope");
    }
  }

  for (const verifier of config.verifiers) {
    if (verifier.required || matches(changedFiles, verifier.scope)) {
      selectedVerifiers.add(verifier.id);
      addReason(
        reasons,
        verifier.id,
        verifier.required ? "repository-required verifier" : "changed files matched verifier scope",
      );
    }
    const matchedRisk = hasRisk(verifier.tags, contract.risks);
    if (matchedRisk) {
      selectedVerifiers.add(verifier.id);
      addReason(reasons, verifier.id, `selected for contract risk ${matchedRisk}`);
    }
  }

  for (const required of contract.required_evidence) {
    if (config.checks.some((check) => check.id === required)) selectedChecks.add(required);
    if (config.invariants.some((invariant) => invariant.id === required))
      selectedInvariants.add(required);
    if (config.verifiers.some((verifier) => verifier.id === required))
      selectedVerifiers.add(required);
    addReason(reasons, required, "explicitly required by approved contract");
  }

  const qaRequired =
    config.qa.enabled &&
    (contract.required_evidence.some((id) => /qa/i.test(id)) ||
      contract.risks.length > 0 ||
      surfaceIds.some((id) =>
        config.surfaces
          .find((surface) => surface.id === id)
          ?.requires.some((item) => /qa/i.test(item)),
      ));
  if (qaRequired)
    addReason(
      reasons,
      "qa",
      "approved intent or affected surface requires experiential verification",
    );

  return {
    version: 1,
    contract_id: contract.id,
    created_at: new Date().toISOString(),
    changed_files: changedFiles,
    affected_surfaces: surfaceIds.sort(),
    selected_checks: [...selectedChecks].sort(),
    selected_invariants: [...selectedInvariants].sort(),
    selected_verifiers: [...selectedVerifiers].sort(),
    qa_required: qaRequired,
    selection_reasons: reasons,
  };
}

export interface GraphNode {
  surface: string;
  paths: string[];
  evidence: string[];
}

export function buildVerificationGraph(config: TrustConfig): GraphNode[] {
  return config.surfaces.map((surface) => ({
    surface: surface.id,
    paths: surface.paths,
    evidence: [
      ...new Set([
        ...surface.requires,
        ...config.checks
          .filter((check) => micromatch.some(check.scope, surface.paths))
          .map((check) => check.id),
        ...config.invariants
          .filter((invariant) => micromatch.some(invariant.scope, surface.paths))
          .map((invariant) => invariant.id),
        ...config.verifiers
          .filter((verifier) => micromatch.some(verifier.scope, surface.paths))
          .map((verifier) => verifier.id),
      ]),
    ],
  }));
}
