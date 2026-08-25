import { z } from "zod";
import {
  changeContractSchema,
  missionSchema,
  type ChangeContract,
  type Mission,
} from "../../core/src/index.js";
import { sha256 } from "../../core/src/provenance.js";
import { generateMissions } from "../../qa/src/index.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export function missionPromptCacheKey(promptSha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(promptSha256))
    throw new Error("Prompt cache keys require a lowercase SHA-256 prompt digest.");
  return `mission-v3:${promptSha256.slice(0, 52)}`;
}

export const missionEvalCaseSchema = z.object({
  id: z.string().min(1),
  contract: changeContractSchema,
  expected: z.object({
    required_mission_ids: z.array(z.string().min(1)).min(1),
    allowed_mission_ids: z.array(z.string().min(1)).min(1),
    mission_risks: z.record(z.string(), z.string()).default({}),
    max_missions: z.number().int().positive(),
  }),
});

export const missionEvalSuiteSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    description: z.string().min(1),
    cases: z.array(missionEvalCaseSchema).min(1),
  })
  .superRefine((suite, context) => {
    const caseIds = new Set<string>();
    for (const [index, item] of suite.cases.entries()) {
      if (caseIds.has(item.id))
        context.addIssue({
          code: "custom",
          message: `Duplicate evaluation case ID ${JSON.stringify(item.id)}.`,
          path: ["cases", index, "id"],
        });
      caseIds.add(item.id);
      const allowed = new Set(item.expected.allowed_mission_ids);
      for (const id of item.expected.required_mission_ids)
        if (!allowed.has(id))
          context.addIssue({
            code: "custom",
            message: `Required mission ${JSON.stringify(id)} must also be allowed.`,
            path: ["cases", index, "expected", "allowed_mission_ids"],
          });
    }
  });

const runMetadataSchema = z.object({
  case_id: z.string().min(1),
  repetition: z.number().int().positive(),
  latency_ms: z.number().nonnegative().optional(),
  input_tokens: z.number().int().nonnegative().optional(),
  cached_input_tokens: z.number().int().nonnegative().optional(),
  cache_write_input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  response_id: z.string().min(1).optional(),
});

const missionEvalDefectSchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1).max(2_000),
  evidence: z.array(z.string().min(1)).min(1),
  also_found_by_deterministic: z.boolean(),
});

const validRunSchema = runMetadataSchema
  .extend({
    status: z.literal("valid"),
    missions: z.array(missionSchema).min(1),
    human_review: z
      .object({
        reviewer: z.string().min(1),
        reviewed_at: z.string().datetime({ offset: true }),
        approved_mission_ids: z.array(z.string().min(1)),
        rejected_mission_ids: z.array(z.string().min(1)),
        defects: z.array(missionEvalDefectSchema),
        notes: z.string().max(4_000).optional(),
        mission_notes: z.record(z.string(), z.string().max(2_000)).optional(),
      })
      .optional(),
  })
  .superRefine((run, context) => {
    if (!run.human_review) return;
    const missionIds = new Set(run.missions.map((mission) => mission.id));
    const approved = run.human_review.approved_mission_ids;
    const rejected = run.human_review.rejected_mission_ids;
    const labels = [...approved, ...rejected];
    if (new Set(labels).size !== labels.length)
      context.addIssue({
        code: "custom",
        message:
          "Human review mission IDs must be unique and cannot be both approved and rejected.",
        path: ["human_review"],
      });
    const labelled = new Set(labels);
    for (const id of missionIds)
      if (!labelled.has(id))
        context.addIssue({
          code: "custom",
          message: `Human review must classify proposed mission ${JSON.stringify(id)}.`,
          path: ["human_review"],
        });
    for (const id of labelled)
      if (!missionIds.has(id))
        context.addIssue({
          code: "custom",
          message: `Human review references unknown mission ${JSON.stringify(id)}.`,
          path: ["human_review"],
        });
    const defectIds = run.human_review.defects.map((defect) => defect.id);
    if (new Set(defectIds).size !== defectIds.length)
      context.addIssue({
        code: "custom",
        message: "Human review defect IDs must be unique within a run.",
        path: ["human_review", "defects"],
      });
  });

const unsuccessfulRunSchema = runMetadataSchema.extend({
  status: z.enum(["invalid", "refused", "error"]),
  reason: z.string().min(1),
});

export const missionEvalRunSchema = z.union([validRunSchema, unsuccessfulRunSchema]);

export const missionEvalCandidateSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    kind: z.enum(["deterministic", "model"]),
    generator: z.string().min(1),
    generator_version: z.string().min(1),
    provider: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    reasoning_effort: z.string().min(1).optional(),
    prompt_sha256: sha256Schema.optional(),
    prompt_cache: z
      .object({
        key: z.string().min(1).max(64),
        mode: z.literal("explicit"),
        ttl: z.literal("30m"),
      })
      .optional(),
    request_policy: z
      .object({
        api: z.string().min(1),
        store: z.boolean(),
        max_output_tokens: z.number().int().positive(),
        timeout_ms: z.number().int().positive(),
        max_prompt_bytes: z.number().int().positive(),
        max_input_bytes: z.number().int().positive(),
        max_missions_per_case: z.number().int().positive(),
        attempts: z.number().int().positive(),
      })
      .optional(),
    repetitions: z.number().int().min(1).max(10),
    runs: z.array(missionEvalRunSchema).min(1),
  })
  .superRefine((candidate, context) => {
    const runKeys = new Set<string>();
    const defects = new Map<string, string>();
    for (const [index, run] of candidate.runs.entries()) {
      const key = `${run.case_id}\0${run.repetition}`;
      if (runKeys.has(key))
        context.addIssue({
          code: "custom",
          message: `Duplicate run for case ${JSON.stringify(run.case_id)} repetition ${run.repetition}.`,
          path: ["runs", index],
        });
      runKeys.add(key);
      if (run.repetition > candidate.repetitions)
        context.addIssue({
          code: "custom",
          message: `Run repetition exceeds declared repetition count ${candidate.repetitions}.`,
          path: ["runs", index, "repetition"],
        });
      if (
        run.input_tokens !== undefined &&
        (run.cached_input_tokens ?? 0) + (run.cache_write_input_tokens ?? 0) > run.input_tokens
      )
        context.addIssue({
          code: "custom",
          message: "Cached and cache-write input tokens cannot exceed total input tokens.",
          path: ["runs", index],
        });
      if (run.status === "valid" && run.human_review)
        for (const defect of run.human_review.defects) {
          const identity = JSON.stringify({
            summary: defect.summary,
            evidence: [...defect.evidence].sort(),
            also_found_by_deterministic: defect.also_found_by_deterministic,
          });
          const previous = defects.get(defect.id);
          if (previous !== undefined && previous !== identity)
            context.addIssue({
              code: "custom",
              message: `Defect ${JSON.stringify(defect.id)} has inconsistent evidence or baseline classification across runs.`,
              path: ["runs", index, "human_review", "defects"],
            });
          defects.set(defect.id, identity);
        }
    }
    if (candidate.kind !== "model") return;
    for (const field of [
      "provider",
      "model",
      "reasoning_effort",
      "prompt_sha256",
      "prompt_cache",
      "request_policy",
    ] as const)
      if (!candidate[field])
        context.addIssue({
          code: "custom",
          message: `Model candidates require ${field}.`,
          path: [field],
        });
    if (
      candidate.prompt_sha256 &&
      candidate.prompt_cache &&
      candidate.prompt_cache.key !== missionPromptCacheKey(candidate.prompt_sha256)
    )
      context.addIssue({
        code: "custom",
        message: "Model prompt cache key must be derived from the recorded prompt digest.",
        path: ["prompt_cache", "key"],
      });
  });

export type MissionEvalSuite = z.infer<typeof missionEvalSuiteSchema>;
export type MissionEvalCandidate = z.infer<typeof missionEvalCandidateSchema>;

export const missionEvalReviewSchema = z.object({
  version: z.literal(1),
  suite_id: z.string().min(1),
  review_id: z.string().regex(/^[a-f0-9]{16}$/),
  candidate_sha256: sha256Schema,
  reviewer: z.string(),
  reviewed_at: z.string().datetime({ offset: true }).nullable(),
  runs: z.array(
    z.object({
      case_id: z.string().min(1),
      repetition: z.number().int().positive(),
      contract: z.unknown(),
      missions: z.array(missionSchema).min(1),
      decisions: z.array(
        z.object({
          mission_id: z.string().min(1),
          verdict: z.enum(["approved", "rejected"]).nullable(),
          notes: z.string().max(2_000).optional(),
        }),
      ),
      defects: z.array(missionEvalDefectSchema).nullable(),
      notes: z.string().max(4_000).optional(),
    }),
  ),
});

export type MissionEvalReview = z.infer<typeof missionEvalReviewSchema>;

export function missionEvalCandidateDigest(candidateInput: MissionEvalCandidate): string {
  return sha256(missionEvalCandidateSchema.parse(candidateInput));
}

function blindMissions(missions: Mission[]): Mission[] {
  return missions.map((mission) => {
    const blindedMission = { ...mission };
    delete blindedMission.generation;
    return blindedMission;
  });
}

export function createMissionEvalReview(
  suiteInput: MissionEvalSuite,
  candidateInput: MissionEvalCandidate,
): MissionEvalReview {
  const suite = missionEvalSuiteSchema.parse(suiteInput);
  const candidate = missionEvalCandidateSchema.parse(candidateInput);
  const cases = new Map(suite.cases.map((item) => [item.id, item]));
  return missionEvalReviewSchema.parse({
    version: 1,
    suite_id: suite.id,
    review_id: sha256({
      suite_id: suite.id,
      candidate_sha256: missionEvalCandidateDigest(candidate),
    }).slice(0, 16),
    candidate_sha256: missionEvalCandidateDigest(candidate),
    reviewer: "",
    reviewed_at: null,
    runs: candidate.runs.flatMap((run) => {
      if (run.status !== "valid") return [];
      const suiteCase = cases.get(run.case_id);
      if (!suiteCase)
        throw new Error(
          `Candidate references unknown evaluation case ${JSON.stringify(run.case_id)}.`,
        );
      return [
        {
          case_id: run.case_id,
          repetition: run.repetition,
          contract: missionGenerationInput(suiteCase.contract),
          missions: blindMissions(run.missions),
          decisions: run.missions.map((mission) => ({
            mission_id: mission.id,
            verdict: null,
            notes: "",
          })),
          defects: null,
          notes: "",
        },
      ];
    }),
  });
}

export function applyMissionEvalReview(
  suiteInput: MissionEvalSuite,
  candidateInput: MissionEvalCandidate,
  reviewInput: MissionEvalReview,
): MissionEvalCandidate {
  const suite = missionEvalSuiteSchema.parse(suiteInput);
  const candidate = missionEvalCandidateSchema.parse(candidateInput);
  const review = missionEvalReviewSchema.parse(reviewInput);
  if (review.suite_id !== suite.id)
    throw new Error("Review suite ID does not match the evaluation suite.");
  if (review.candidate_sha256 !== missionEvalCandidateDigest(candidate))
    throw new Error("Review candidate digest does not match the candidate artifact.");
  if (!review.reviewer.trim()) throw new Error("A human reviewer identity is required.");
  if (!review.reviewed_at) throw new Error("A review completion timestamp is required.");
  if (Date.parse(review.reviewed_at) > Date.now())
    throw new Error("Review completion timestamp cannot be in the future.");

  const reviews = new Map<string, MissionEvalReview["runs"][number]>();
  for (const item of review.runs) {
    const key = `${item.case_id}\0${item.repetition}`;
    if (reviews.has(key))
      throw new Error(`Duplicate review entry for ${item.case_id} run ${item.repetition}.`);
    reviews.set(key, item);
  }
  const validRuns = candidate.runs.filter((run) => run.status === "valid");
  const cases = new Map(suite.cases.map((item) => [item.id, item]));
  if (reviews.size !== validRuns.length)
    throw new Error("Review must contain exactly one entry for every valid candidate run.");

  const runs = candidate.runs.map((run) => {
    if (run.status !== "valid") return run;
    const key = `${run.case_id}\0${run.repetition}`;
    const item = reviews.get(key);
    if (!item) throw new Error(`Review is missing ${run.case_id} run ${run.repetition}.`);
    const suiteCase = cases.get(run.case_id);
    if (!suiteCase) throw new Error(`Candidate references unknown case ${run.case_id}.`);
    if (sha256(item.contract) !== sha256(missionGenerationInput(suiteCase.contract)))
      throw new Error(`Review contract content does not match ${run.case_id}.`);
    if (sha256(item.missions) !== sha256(blindMissions(run.missions)))
      throw new Error(
        `Review mission content does not match ${run.case_id} run ${run.repetition}.`,
      );
    const missionIds = new Set(run.missions.map((mission) => mission.id));
    const decisionIds = item.decisions.map((decision) => decision.mission_id);
    if (
      decisionIds.length !== missionIds.size ||
      new Set(decisionIds).size !== decisionIds.length ||
      decisionIds.some((id) => !missionIds.has(id))
    )
      throw new Error(`Review mission set does not match ${run.case_id} run ${run.repetition}.`);
    if (item.decisions.some((decision) => decision.verdict === null))
      throw new Error(`Review has unclassified missions in ${run.case_id} run ${run.repetition}.`);
    if (item.defects === null)
      throw new Error(`Review is missing defect yield for ${run.case_id} run ${run.repetition}.`);
    const missionNotes = Object.fromEntries(
      item.decisions.flatMap((decision) =>
        decision.notes?.trim() ? [[decision.mission_id, decision.notes.trim()]] : [],
      ),
    );
    return {
      ...run,
      human_review: {
        reviewer: review.reviewer.trim(),
        reviewed_at: review.reviewed_at,
        approved_mission_ids: item.decisions.flatMap((decision) =>
          decision.verdict === "approved" ? [decision.mission_id] : [],
        ),
        rejected_mission_ids: item.decisions.flatMap((decision) =>
          decision.verdict === "rejected" ? [decision.mission_id] : [],
        ),
        defects: item.defects,
        ...(item.notes?.trim() ? { notes: item.notes.trim() } : {}),
        ...(Object.keys(missionNotes).length ? { mission_notes: missionNotes } : {}),
      },
    };
  });
  return missionEvalCandidateSchema.parse({ ...candidate, runs });
}

function fencedJson(value: unknown): string {
  const content = JSON.stringify(value, null, 2);
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}json\n${content}\n${fence}`;
}

export function renderMissionEvalReviewMarkdown(reviewInput: MissionEvalReview): string {
  const review = missionEvalReviewSchema.parse(reviewInput);
  const decisions = review.runs.flatMap((run) => run.decisions);
  const classified = decisions.filter((decision) => decision.verdict !== null).length;
  const defectCounts = review.runs.filter((run) => run.defects !== null).length;
  const sections = review.runs.flatMap((run) => [
    `## ${JSON.stringify(run.case_id)} — repetition ${run.repetition}`,
    "",
    "Contract input:",
    "",
    fencedJson(run.contract),
    "",
    "Proposed missions and editable decisions:",
    "",
    fencedJson({
      missions: run.missions,
      decisions: run.decisions,
      defects: run.defects,
      notes: run.notes ?? "",
    }),
    "",
  ]);
  return `${[
    `# Blinded human review: ${review.review_id}`,
    "",
    `- Suite: \`${review.suite_id}\``,
    `- Candidate SHA-256: \`${review.candidate_sha256}\``,
    `- Reviewer: ${review.reviewer || "not set"}`,
    `- Reviewed at: ${review.reviewed_at ?? "not set"}`,
    `- Classified missions: ${classified}/${decisions.length}`,
    `- Runs with defect yield: ${defectCounts}/${review.runs.length}`,
    "",
    "Edit the companion review JSON, not this rendering. Set one human reviewer identity and UTC completion timestamp; classify every mission as approved or rejected; record an integer defect count for every run. Defects must be observed by executing the proposed mission, not inferred from its wording.",
    "",
    "The review is bound to the exact candidate digest. Applying it to a changed model, prompt, response, or mission artifact fails closed.",
    "",
    ...sections,
  ].join("\n")}\n`;
}

export interface MissionEvalRunScore {
  case_id: string;
  repetition: number;
  status: "valid" | "invalid" | "refused" | "error";
  hard_pass: boolean;
  required_recall: number;
  allowed_precision: number;
  risk_accuracy: number;
  duplicate_count: number;
  unsupported_mission_ids: string[];
  missing_required_mission_ids: string[];
  provenance_complete: boolean;
  within_mission_budget: boolean;
  reason?: string;
}

export interface MissionEvalReport {
  version: 1;
  suite_id: string;
  suite_sha256: string;
  candidate_sha256: string;
  scorer: {
    name: "executable-trust-layer/mission-evaluator";
    version: "1";
  };
  candidate: Omit<MissionEvalCandidate, "runs">;
  summary: {
    total_runs: number;
    valid_output_rate: number;
    hard_pass_rate: number;
    required_recall: number;
    allowed_precision: number;
    risk_accuracy: number;
    provenance_rate: number;
    stability: number;
    mean_latency_ms?: number;
    mean_input_tokens?: number;
    mean_cached_input_tokens?: number;
    mean_cache_write_input_tokens?: number;
    prompt_cache_hit_rate?: number;
    prompt_cache_write_rate?: number;
    mean_output_tokens?: number;
    human_reviewed_runs: number;
    human_approval_rate?: number;
    defects_found?: number;
    unique_defects_found?: number;
  };
  runs: MissionEvalRunScore[];
}

export const missionModelSelectionPolicySchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    suite_id: z.string().min(1),
    suite_sha256: sha256Schema,
    evaluation_mode: z.enum(["research_only", "executed_pilot"]),
    production_default: z.literal("deterministic"),
    pricing: z.object({
      checked_at: z.string().date(),
      source_url: z.string().url(),
      service_tier: z.literal("standard"),
      context: z.literal("short"),
      currency: z.literal("USD"),
      per_tokens: z.literal(1_000_000),
      cached_input_multiplier: z.number().min(0).max(1),
      cache_write_input_multiplier: z.number().min(1),
    }),
    candidates: z
      .array(
        z.object({
          provider: z.string().min(1),
          model: z.string().min(1),
          reasoning_effort: z.string().min(1),
          input_usd_per_million: z.number().nonnegative(),
          output_usd_per_million: z.number().nonnegative(),
        }),
      )
      .min(1),
    gates: z.object({
      valid_output_rate: z.number().min(0).max(1),
      hard_pass_rate: z.number().min(0).max(1),
      required_recall: z.number().min(0).max(1),
      allowed_precision: z.number().min(0).max(1),
      risk_accuracy: z.number().min(0).max(1),
      provenance_rate: z.number().min(0).max(1),
      stability: z.number().min(0).max(1),
      human_reviewed_runs: z.number().int().nonnegative(),
      human_approval_rate: z.number().min(0).max(1),
      unique_defects_found: z.number().int().nonnegative(),
      max_mean_latency_ms: z.number().positive(),
      min_prompt_cache_hit_rate: z.number().min(0).max(1),
    }),
  })
  .superRefine((policy, context) => {
    const identities = new Set<string>();
    for (const [index, candidate] of policy.candidates.entries()) {
      const identity = `${candidate.provider}/${candidate.model}/${candidate.reasoning_effort}`;
      if (identities.has(identity))
        context.addIssue({
          code: "custom",
          message: `Duplicate model candidate ${identity}.`,
          path: ["candidates", index],
        });
      identities.add(identity);
    }
  });

export type MissionModelSelectionPolicy = z.infer<typeof missionModelSelectionPolicySchema>;

const missionModelReportSchema = z
  .object({
    version: z.literal(1),
    suite_id: z.string().min(1),
    suite_sha256: sha256Schema,
    candidate_sha256: sha256Schema,
    scorer: z.object({
      name: z.literal("executable-trust-layer/mission-evaluator"),
      version: z.literal("1"),
    }),
    candidate: z.object({
      id: z.string().min(1),
      kind: z.literal("model"),
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoning_effort: z.string().min(1),
    }),
    summary: z.object({
      total_runs: z.number().int().positive(),
      valid_output_rate: z.number().min(0).max(1),
      hard_pass_rate: z.number().min(0).max(1),
      required_recall: z.number().min(0).max(1),
      allowed_precision: z.number().min(0).max(1),
      risk_accuracy: z.number().min(0).max(1),
      provenance_rate: z.number().min(0).max(1),
      stability: z.number().min(0).max(1),
      human_reviewed_runs: z.number().int().nonnegative(),
      human_approval_rate: z.number().min(0).max(1).optional(),
      defects_found: z.number().int().nonnegative().optional(),
      unique_defects_found: z.number().int().nonnegative().optional(),
      mean_latency_ms: z.number().nonnegative().optional(),
      mean_input_tokens: z.number().nonnegative().optional(),
      mean_cached_input_tokens: z.number().nonnegative().optional(),
      mean_cache_write_input_tokens: z.number().nonnegative().optional(),
      prompt_cache_hit_rate: z.number().min(0).max(1).optional(),
      prompt_cache_write_rate: z.number().min(0).max(1).optional(),
      mean_output_tokens: z.number().nonnegative().optional(),
    }),
  })
  .superRefine((report, context) => {
    const input = report.summary.mean_input_tokens;
    if (
      input !== undefined &&
      (report.summary.mean_cached_input_tokens ?? 0) +
        (report.summary.mean_cache_write_input_tokens ?? 0) >
        input
    )
      context.addIssue({
        code: "custom",
        message: "Mean cached and cache-write tokens cannot exceed mean input tokens.",
        path: ["summary"],
      });
    if (
      report.summary.unique_defects_found !== undefined &&
      (report.summary.defects_found === undefined ||
        report.summary.unique_defects_found > report.summary.defects_found)
    )
      context.addIssue({
        code: "custom",
        message: "Unique defect yield cannot exceed total evidence-linked defect yield.",
        path: ["summary", "unique_defects_found"],
      });
  });

export type MissionModelReport = z.infer<typeof missionModelReportSchema>;

export interface MissionModelDecision {
  version: 1;
  policy_id: string;
  suite_id: string;
  status: "selected" | "insufficient_evidence";
  production_mission_generation: "deterministic";
  proposal_model: {
    provider: string;
    model: string;
    reasoning_effort: string;
  } | null;
  automated_recommendation: {
    provider: string;
    model: string;
    reasoning_effort: string;
  } | null;
  candidates: Array<{
    provider: string;
    model: string;
    reasoning_effort: string;
    automated_eligible: boolean;
    eligible: boolean;
    automated_reasons: string[];
    review_reasons: string[];
    reasons: string[];
    report_id?: string;
    hard_pass_rate?: number;
    required_recall?: number;
    stability?: number;
    mean_latency_ms?: number;
    prompt_cache_hit_rate?: number;
    human_approval_rate?: number;
    unique_defects_found?: number;
    estimated_cost_per_run_usd?: number;
    estimated_cost_per_suite_usd?: number;
  }>;
}

export function missionGenerationInput(contract: ChangeContract): unknown {
  return {
    version: contract.version,
    id: contract.id,
    intent: contract.intent,
    expected_behaviors: contract.expected_behaviors,
    affected_surfaces: contract.affected_surfaces,
    risks: contract.risks,
    required_evidence: contract.required_evidence,
    excluded: contract.excluded,
  };
}

function mean(values: number[]): number | undefined {
  if (!values.length) return undefined;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  return [...left].filter((value) => right.has(value)).length / union.size;
}

function candidateProvenanceComplete(
  candidate: MissionEvalCandidate,
  contract: ChangeContract,
  missions: Mission[],
): boolean {
  const expectedInput = sha256(missionGenerationInput(contract));
  const deterministicById = new Map(
    generateMissions(contract).map((mission) => [mission.id, mission.generation]),
  );
  return missions.every((mission) => {
    const generation = mission.generation;
    if (!generation || generation.method !== candidate.kind) return false;
    if (
      generation.generator !== candidate.generator ||
      generation.version !== candidate.generator_version
    )
      return false;
    if (candidate.kind === "deterministic") {
      const expected = deterministicById.get(mission.id);
      return (
        expected?.method === "deterministic" && generation.input_sha256 === expected.input_sha256
      );
    }
    return (
      generation.input_sha256 === expectedInput &&
      generation.provider === candidate.provider &&
      generation.model === candidate.model &&
      generation.prompt_sha256 === candidate.prompt_sha256
    );
  });
}

function scoreValidRun(
  suiteCase: MissionEvalSuite["cases"][number],
  candidate: MissionEvalCandidate,
  run: Extract<MissionEvalCandidate["runs"][number], { status: "valid" }>,
): MissionEvalRunScore {
  const ids = run.missions.map((mission) => mission.id);
  const uniqueIds = new Set(ids);
  const canonicalRiskId = (risk: string): string =>
    `risk-${risk
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "")}`;
  const required = new Set([
    ...suiteCase.expected.required_mission_ids,
    ...(candidate.kind === "model" ? suiteCase.contract.risks.map(canonicalRiskId) : []),
  ]);
  const allowed = new Set(suiteCase.expected.allowed_mission_ids);
  const behaviorIds = new Set(suiteCase.contract.expected_behaviors.map((behavior) => behavior.id));
  const declaredRisks = new Set(suiteCase.contract.risks.map((risk) => risk.trim().toLowerCase()));
  const missing = [...required].filter((id) => !uniqueIds.has(id));
  const groundedExtra = (mission: Mission): boolean => {
    if (behaviorIds.has(mission.id)) return false;
    const risk = mission.risk?.trim().toLowerCase();
    return (
      risk !== undefined &&
      declaredRisks.has(risk) &&
      mission.derived_from.some((source) => source.trim().toLowerCase() === risk)
    );
  };
  const unsupported = run.missions
    .filter((mission) => !allowed.has(mission.id) && !groundedExtra(mission))
    .map((mission) => mission.id);
  const duplicateCount = ids.length - uniqueIds.size;
  const requiredRecall = (required.size - missing.length) / required.size;
  const allowedPrecision = uniqueIds.size
    ? (uniqueIds.size - unsupported.length) / uniqueIds.size
    : 0;
  const riskAccuracy =
    candidate.kind === "model"
      ? (() => {
          const classified = run.missions.filter((mission) => mission.risk !== undefined);
          if (!classified.length) return 1;
          return (
            classified.filter((mission) => declaredRisks.has(mission.risk!.trim().toLowerCase()))
              .length / classified.length
          );
        })()
      : (() => {
          const riskExpectations = suiteCase.expected.allowed_mission_ids;
          const correctRisks = riskExpectations.filter((id) => {
            const expected = suiteCase.expected.mission_risks[id];
            const mission = run.missions.find((item) => item.id === id);
            const actual = mission?.risk?.trim().toLowerCase();
            return expected === undefined
              ? actual === undefined
              : actual === expected.trim().toLowerCase();
          }).length;
          return correctRisks / riskExpectations.length;
        })();
  const provenanceComplete = candidateProvenanceComplete(
    candidate,
    suiteCase.contract,
    run.missions,
  );
  const withinMissionBudget = run.missions.length <= suiteCase.expected.max_missions;
  return {
    case_id: run.case_id,
    repetition: run.repetition,
    status: run.status,
    hard_pass:
      requiredRecall === 1 &&
      allowedPrecision === 1 &&
      riskAccuracy === 1 &&
      duplicateCount === 0 &&
      provenanceComplete &&
      withinMissionBudget,
    required_recall: requiredRecall,
    allowed_precision: allowedPrecision,
    risk_accuracy: riskAccuracy,
    duplicate_count: duplicateCount,
    unsupported_mission_ids: unsupported,
    missing_required_mission_ids: missing,
    provenance_complete: provenanceComplete,
    within_mission_budget: withinMissionBudget,
  };
}

export function scoreMissionEval(
  suiteInput: MissionEvalSuite,
  candidateInput: MissionEvalCandidate,
): MissionEvalReport {
  const suite = missionEvalSuiteSchema.parse(suiteInput);
  const candidate = missionEvalCandidateSchema.parse(candidateInput);
  const cases = new Map(suite.cases.map((item) => [item.id, item]));
  const runs = new Map(candidate.runs.map((run) => [`${run.case_id}\0${run.repetition}`, run]));
  const scores: MissionEvalRunScore[] = [];
  for (const suiteCase of suite.cases)
    for (let repetition = 1; repetition <= candidate.repetitions; repetition++) {
      const run = runs.get(`${suiteCase.id}\0${repetition}`);
      if (!run) {
        scores.push({
          case_id: suiteCase.id,
          repetition,
          status: "error",
          hard_pass: false,
          required_recall: 0,
          allowed_precision: 0,
          risk_accuracy: 0,
          duplicate_count: 0,
          unsupported_mission_ids: [],
          missing_required_mission_ids: suiteCase.expected.required_mission_ids,
          provenance_complete: false,
          within_mission_budget: false,
          reason: "Candidate omitted this required evaluation run.",
        });
      } else if (run.status === "valid") scores.push(scoreValidRun(suiteCase, candidate, run));
      else
        scores.push({
          case_id: run.case_id,
          repetition: run.repetition,
          status: run.status,
          hard_pass: false,
          required_recall: 0,
          allowed_precision: 0,
          risk_accuracy: 0,
          duplicate_count: 0,
          unsupported_mission_ids: [],
          missing_required_mission_ids: suiteCase.expected.required_mission_ids,
          provenance_complete: false,
          within_mission_budget: false,
          reason: run.reason,
        });
    }
  for (const run of candidate.runs)
    if (!cases.has(run.case_id))
      scores.push({
        case_id: run.case_id,
        repetition: run.repetition,
        status: run.status,
        hard_pass: false,
        required_recall: 0,
        allowed_precision: 0,
        risk_accuracy: 0,
        duplicate_count: 0,
        unsupported_mission_ids: [],
        missing_required_mission_ids: [],
        provenance_complete: false,
        within_mission_budget: false,
        reason: "Candidate references an unknown evaluation case.",
      });
  const validRuns = candidate.runs
    .filter((run): run is Extract<typeof run, { status: "valid" }> => run.status === "valid")
    .filter((run) => cases.has(run.case_id));
  const pairs: number[] = [];
  for (const suiteCase of suite.cases) {
    const repeated = validRuns.filter((run) => run.case_id === suiteCase.id);
    for (let left = 0; left < repeated.length; left++)
      for (let right = left + 1; right < repeated.length; right++)
        pairs.push(
          jaccard(
            new Set(repeated[left]!.missions.map((mission) => mission.id)),
            new Set(repeated[right]!.missions.map((mission) => mission.id)),
          ),
        );
  }
  const reviewed = validRuns.filter((run) => run.human_review);
  const reviewedMissions = reviewed.reduce((total, run) => total + run.missions.length, 0);
  const approvedMissions = reviewed.reduce(
    (total, run) => total + (run.human_review?.approved_mission_ids.length ?? 0),
    0,
  );
  const candidateMetadata = { ...candidate };
  delete (candidateMetadata as Partial<MissionEvalCandidate>).runs;
  const summary: MissionEvalReport["summary"] = {
    total_runs: scores.length,
    valid_output_rate: validRuns.length / scores.length,
    hard_pass_rate: scores.filter((score) => score.hard_pass).length / scores.length,
    required_recall: mean(scores.map((score) => score.required_recall)) ?? 0,
    allowed_precision: mean(scores.map((score) => score.allowed_precision)) ?? 0,
    risk_accuracy: mean(scores.map((score) => score.risk_accuracy)) ?? 0,
    provenance_rate: scores.filter((score) => score.provenance_complete).length / scores.length,
    stability: pairs.length ? (mean(pairs) ?? 0) : 1,
    human_reviewed_runs: reviewed.length,
  };
  const latencies = candidate.runs.flatMap((run) =>
    run.latency_ms === undefined ? [] : [run.latency_ms],
  );
  const inputTokens = candidate.runs.flatMap((run) =>
    run.input_tokens === undefined ? [] : [run.input_tokens],
  );
  const cachedInputTokens = candidate.runs.flatMap((run) =>
    run.cached_input_tokens === undefined ? [] : [run.cached_input_tokens],
  );
  const cacheWriteInputTokens = candidate.runs.flatMap((run) =>
    run.cache_write_input_tokens === undefined ? [] : [run.cache_write_input_tokens],
  );
  const outputTokens = candidate.runs.flatMap((run) =>
    run.output_tokens === undefined ? [] : [run.output_tokens],
  );
  const meanLatency = mean(latencies);
  const meanInputTokens = mean(inputTokens);
  const meanCachedInputTokens = mean(cachedInputTokens);
  const meanCacheWriteInputTokens = mean(cacheWriteInputTokens);
  const meanOutputTokens = mean(outputTokens);
  if (meanLatency !== undefined) summary.mean_latency_ms = meanLatency;
  if (meanInputTokens !== undefined) summary.mean_input_tokens = meanInputTokens;
  if (meanCachedInputTokens !== undefined) summary.mean_cached_input_tokens = meanCachedInputTokens;
  if (meanCacheWriteInputTokens !== undefined)
    summary.mean_cache_write_input_tokens = meanCacheWriteInputTokens;
  if (
    inputTokens.length === candidate.runs.length &&
    cachedInputTokens.length === inputTokens.length
  ) {
    const totalInputTokens = inputTokens.reduce((total, value) => total + value, 0);
    summary.prompt_cache_hit_rate = totalInputTokens
      ? cachedInputTokens.reduce((total, value) => total + value, 0) / totalInputTokens
      : 0;
  }
  if (
    inputTokens.length === candidate.runs.length &&
    cacheWriteInputTokens.length === inputTokens.length
  ) {
    const totalInputTokens = inputTokens.reduce((total, value) => total + value, 0);
    summary.prompt_cache_write_rate = totalInputTokens
      ? cacheWriteInputTokens.reduce((total, value) => total + value, 0) / totalInputTokens
      : 0;
  }
  if (meanOutputTokens !== undefined) summary.mean_output_tokens = meanOutputTokens;
  if (reviewedMissions) summary.human_approval_rate = approvedMissions / reviewedMissions;
  if (reviewed.length) {
    const defects = new Map(
      reviewed.flatMap((run) =>
        (run.human_review?.defects ?? []).map((defect) => [defect.id, defect]),
      ),
    );
    summary.defects_found = defects.size;
    summary.unique_defects_found = [...defects.values()].filter(
      (defect) => !defect.also_found_by_deterministic,
    ).length;
  }
  return {
    version: 1,
    suite_id: suite.id,
    suite_sha256: sha256(suite),
    candidate_sha256: missionEvalCandidateDigest(candidate),
    scorer: { name: "executable-trust-layer/mission-evaluator", version: "1" },
    candidate: candidateMetadata,
    summary,
    runs: scores,
  };
}

export function deterministicMissionCandidate(suiteInput: MissionEvalSuite): MissionEvalCandidate {
  const suite = missionEvalSuiteSchema.parse(suiteInput);
  return missionEvalCandidateSchema.parse({
    version: 1,
    id: "intent-heuristics-v1",
    kind: "deterministic",
    generator: "executable-trust-layer/intent-heuristics",
    generator_version: "1",
    repetitions: 1,
    runs: suite.cases.map((item) => ({
      case_id: item.id,
      repetition: 1,
      status: "valid",
      missions: generateMissions(item.contract),
    })),
  });
}

function candidateIdentity(candidate: {
  provider: string;
  model: string;
  reasoning_effort: string;
}): string {
  return `${candidate.provider}\0${candidate.model}\0${candidate.reasoning_effort}`;
}

export function selectMissionProposalModel(
  policyInput: MissionModelSelectionPolicy,
  reportInputs: MissionModelReport[],
): MissionModelDecision {
  const policy = missionModelSelectionPolicySchema.parse(policyInput);
  const reports = reportInputs.map((report) => missionModelReportSchema.parse(report));
  const byCandidate = new Map<string, MissionModelReport>();
  for (const report of reports) {
    const identity = candidateIdentity(report.candidate);
    if (byCandidate.has(identity))
      throw new Error(
        `Multiple benchmark reports were supplied for ${report.candidate.provider}/${report.candidate.model}/${report.candidate.reasoning_effort}.`,
      );
    byCandidate.set(identity, report);
  }
  const evaluated = policy.candidates.map((candidate) => {
    const report = byCandidate.get(candidateIdentity(candidate));
    const automatedReasons: string[] = [];
    const reviewReasons: string[] = [];
    if (policy.evaluation_mode === "research_only")
      reviewReasons.push(
        "The policy suite is research-only and cannot select a proposal model; use a digest-pinned executed-pilot suite.",
      );
    if (!report) automatedReasons.push("No benchmark report was supplied.");
    else if (report.suite_id !== policy.suite_id)
      automatedReasons.push(
        `Report suite ${JSON.stringify(report.suite_id)} does not match policy suite.`,
      );
    else if (report.suite_sha256 !== policy.suite_sha256)
      automatedReasons.push("Report suite digest does not match the model-selection policy.");
    else {
      const summary = report.summary;
      const minimums = [
        ["valid output rate", summary.valid_output_rate, policy.gates.valid_output_rate],
        ["hard-pass rate", summary.hard_pass_rate, policy.gates.hard_pass_rate],
        ["required recall", summary.required_recall, policy.gates.required_recall],
        ["allowed precision", summary.allowed_precision, policy.gates.allowed_precision],
        ["risk accuracy", summary.risk_accuracy, policy.gates.risk_accuracy],
        ["provenance rate", summary.provenance_rate, policy.gates.provenance_rate],
        ["stability", summary.stability, policy.gates.stability],
      ] as const;
      for (const [label, actual, minimum] of minimums)
        if (actual < minimum)
          automatedReasons.push(`${label} ${percent(actual)} is below ${percent(minimum)}.`);
      if (summary.human_reviewed_runs < policy.gates.human_reviewed_runs)
        reviewReasons.push(
          `Human-reviewed runs ${summary.human_reviewed_runs} are below ${policy.gates.human_reviewed_runs}.`,
        );
      if (
        summary.human_approval_rate === undefined ||
        summary.human_approval_rate < policy.gates.human_approval_rate
      )
        reviewReasons.push(
          summary.human_approval_rate === undefined
            ? "Human approval rate is missing."
            : `Human approval rate ${percent(summary.human_approval_rate)} is below ${percent(policy.gates.human_approval_rate)}.`,
        );
      if (
        summary.unique_defects_found === undefined ||
        summary.unique_defects_found < policy.gates.unique_defects_found
      )
        reviewReasons.push(
          summary.unique_defects_found === undefined
            ? "Unique observed defect yield is missing."
            : `Unique observed defects ${summary.unique_defects_found} are below ${policy.gates.unique_defects_found}.`,
        );
      if (
        summary.mean_latency_ms === undefined ||
        summary.mean_latency_ms > policy.gates.max_mean_latency_ms
      )
        automatedReasons.push(
          summary.mean_latency_ms === undefined
            ? "Mean latency is missing."
            : `Mean latency ${summary.mean_latency_ms.toFixed(0)} ms exceeds ${policy.gates.max_mean_latency_ms.toFixed(0)} ms.`,
        );
      if (
        summary.prompt_cache_hit_rate === undefined ||
        summary.prompt_cache_hit_rate < policy.gates.min_prompt_cache_hit_rate
      )
        automatedReasons.push(
          summary.prompt_cache_hit_rate === undefined
            ? "Prompt cache hit rate is missing."
            : `Prompt cache hit rate ${percent(summary.prompt_cache_hit_rate)} is below ${percent(policy.gates.min_prompt_cache_hit_rate)}.`,
        );
    }
    const estimatedCostPerRun =
      report?.summary.mean_input_tokens === undefined ||
      report.summary.mean_output_tokens === undefined
        ? undefined
        : ((report.summary.mean_input_tokens -
            (report.summary.mean_cached_input_tokens ?? 0) -
            (report.summary.mean_cache_write_input_tokens ?? 0)) *
            candidate.input_usd_per_million +
            (report.summary.mean_cached_input_tokens ?? 0) *
              candidate.input_usd_per_million *
              policy.pricing.cached_input_multiplier +
            (report.summary.mean_cache_write_input_tokens ?? 0) *
              candidate.input_usd_per_million *
              policy.pricing.cache_write_input_multiplier +
            report.summary.mean_output_tokens * candidate.output_usd_per_million) /
          policy.pricing.per_tokens;
    const reasons = [...automatedReasons, ...reviewReasons];
    return {
      ...candidate,
      automated_eligible: automatedReasons.length === 0,
      eligible: reasons.length === 0,
      automated_reasons: automatedReasons,
      review_reasons: reviewReasons,
      reasons,
      ...(report ? { report_id: report.candidate.id } : {}),
      ...(report ? { hard_pass_rate: report.summary.hard_pass_rate } : {}),
      ...(report ? { required_recall: report.summary.required_recall } : {}),
      ...(report ? { stability: report.summary.stability } : {}),
      ...(report?.summary.mean_latency_ms === undefined
        ? {}
        : { mean_latency_ms: report.summary.mean_latency_ms }),
      ...(report?.summary.prompt_cache_hit_rate === undefined
        ? {}
        : { prompt_cache_hit_rate: report.summary.prompt_cache_hit_rate }),
      ...(report?.summary.human_approval_rate === undefined
        ? {}
        : { human_approval_rate: report.summary.human_approval_rate }),
      ...(report?.summary.unique_defects_found === undefined
        ? {}
        : { unique_defects_found: report.summary.unique_defects_found }),
      ...(estimatedCostPerRun === undefined
        ? {}
        : {
            estimated_cost_per_run_usd: estimatedCostPerRun,
            estimated_cost_per_suite_usd: estimatedCostPerRun * report!.summary.total_runs,
          }),
      report,
    };
  });
  const compareCandidates = (
    left: (typeof evaluated)[number],
    right: (typeof evaluated)[number],
  ): number => {
    const leftSummary = left.report!.summary;
    const rightSummary = right.report!.summary;
    return (
      (rightSummary.unique_defects_found ?? 0) - (leftSummary.unique_defects_found ?? 0) ||
      (rightSummary.defects_found ?? 0) - (leftSummary.defects_found ?? 0) ||
      (rightSummary.human_approval_rate ?? 0) - (leftSummary.human_approval_rate ?? 0) ||
      rightSummary.hard_pass_rate - leftSummary.hard_pass_rate ||
      rightSummary.required_recall - leftSummary.required_recall ||
      rightSummary.stability - leftSummary.stability ||
      (left.estimated_cost_per_run_usd ?? Number.POSITIVE_INFINITY) -
        (right.estimated_cost_per_run_usd ?? Number.POSITIVE_INFINITY) ||
      (leftSummary.mean_latency_ms ?? Number.POSITIVE_INFINITY) -
        (rightSummary.mean_latency_ms ?? Number.POSITIVE_INFINITY)
    );
  };
  const eligible = evaluated
    .filter((candidate) => candidate.eligible && candidate.report)
    .sort(compareCandidates);
  const selected = eligible[0];
  // Schema compliance, latency, and price do not establish that model-authored
  // prose changes what a repository adapter executes. A recommendation is only
  // meaningful after the same operational and human gates required for selection.
  const automatedRecommendation = selected;
  return {
    version: 1,
    policy_id: policy.id,
    suite_id: policy.suite_id,
    status: selected ? "selected" : "insufficient_evidence",
    production_mission_generation: "deterministic",
    proposal_model: selected
      ? {
          provider: selected.provider,
          model: selected.model,
          reasoning_effort: selected.reasoning_effort,
        }
      : null,
    automated_recommendation: automatedRecommendation
      ? {
          provider: automatedRecommendation.provider,
          model: automatedRecommendation.model,
          reasoning_effort: automatedRecommendation.reasoning_effort,
        }
      : null,
    candidates: evaluated.map(({ report: _report, ...candidate }) => candidate),
  };
}

export function renderMissionModelDecisionMarkdown(decision: MissionModelDecision): string {
  const selected = decision.proposal_model;
  const automated = decision.automated_recommendation;
  const rows = decision.candidates.map(
    (candidate) =>
      `| ${candidate.provider}/${candidate.model} | ${candidate.automated_eligible ? "yes" : "no"} | ${candidate.eligible ? "yes" : "no"} | ${candidate.hard_pass_rate === undefined ? "-" : percent(candidate.hard_pass_rate)} | ${candidate.required_recall === undefined ? "-" : percent(candidate.required_recall)} | ${candidate.stability === undefined ? "-" : percent(candidate.stability)} | ${candidate.prompt_cache_hit_rate === undefined ? "-" : percent(candidate.prompt_cache_hit_rate)} | ${candidate.human_approval_rate === undefined ? "-" : percent(candidate.human_approval_rate)} | ${candidate.unique_defects_found ?? "-"} | ${candidate.mean_latency_ms === undefined ? "-" : candidate.mean_latency_ms.toFixed(0)} | ${candidate.estimated_cost_per_run_usd === undefined ? "-" : `$${candidate.estimated_cost_per_run_usd.toFixed(6)}`} | ${candidate.reasons.join(" ") || "All gates passed."} |`,
  );
  return `${[
    "# Mission proposal model decision",
    "",
    `Status: **${decision.status.replaceAll("_", " ")}**`,
    "",
    "Production mission generation remains deterministic. Model output can only propose draft missions before human approval.",
    "",
    selected
      ? `Selected proposal model: **${selected.provider}/${selected.model}** with **${selected.reasoning_effort}** reasoning.`
      : "Selected proposal model: **none**. Continue using the deterministic generator.",
    "",
    automated
      ? `Qualified proposal-model recommendation: **${automated.provider}/${automated.model}** with **${automated.reasoning_effort}** reasoning.`
      : "Qualified proposal-model recommendation: **none**. Automated text-quality and cost checks are not evidence of executable coverage.",
    "",
    "Estimated costs use measured ordinary, cache-read, cache-write, and output tokens with the policy's standard short-context prices; they exclude regional uplifts.",
    "",
    "| Candidate | Text/cache gates | All gates | Hard pass | Recall | Stability | Cache hit | Human approval | Unique defects | Latency ms | Cost/run | Blockers |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows,
    "",
  ].join("\n")}\n`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMissionEvalMarkdown(report: MissionEvalReport): string {
  const summary = report.summary;
  const rows = report.runs.map(
    (run) =>
      `| ${run.case_id} | ${run.repetition} | ${run.status} | ${run.hard_pass ? "yes" : "no"} | ${percent(run.required_recall)} | ${percent(run.allowed_precision)} | ${run.missing_required_mission_ids.join(", ") || "-"} | ${run.unsupported_mission_ids.join(", ") || "-"} |`,
  );
  return `${[
    `# Mission generation evaluation: ${report.candidate.id}`,
    "",
    `Suite: \`${report.suite_id}\``,
    `Suite SHA-256: \`${report.suite_sha256}\``,
    `Candidate SHA-256: \`${report.candidate_sha256}\``,
    `Scorer: \`${report.scorer.name}@${report.scorer.version}\``,
    "",
    `- Valid output: ${percent(summary.valid_output_rate)}`,
    `- Hard pass: ${percent(summary.hard_pass_rate)}`,
    `- Required mission recall: ${percent(summary.required_recall)}`,
    `- Allowed mission precision: ${percent(summary.allowed_precision)}`,
    `- Risk accuracy: ${percent(summary.risk_accuracy)}`,
    `- Provenance complete: ${percent(summary.provenance_rate)}`,
    `- Repetition stability: ${percent(summary.stability)}`,
    `- Human-reviewed runs: ${summary.human_reviewed_runs}`,
    ...(summary.mean_latency_ms === undefined
      ? []
      : [`- Mean latency: ${summary.mean_latency_ms.toFixed(0)} ms`]),
    ...(summary.mean_input_tokens === undefined
      ? []
      : [`- Mean input tokens: ${summary.mean_input_tokens.toFixed(0)}`]),
    ...(summary.mean_cached_input_tokens === undefined
      ? []
      : [`- Mean cached input tokens: ${summary.mean_cached_input_tokens.toFixed(0)}`]),
    ...(summary.mean_cache_write_input_tokens === undefined
      ? []
      : [`- Mean cache-write input tokens: ${summary.mean_cache_write_input_tokens.toFixed(0)}`]),
    ...(summary.prompt_cache_hit_rate === undefined
      ? []
      : [`- Prompt cache token-hit rate: ${percent(summary.prompt_cache_hit_rate)}`]),
    ...(summary.prompt_cache_write_rate === undefined
      ? []
      : [`- Prompt cache token-write rate: ${percent(summary.prompt_cache_write_rate)}`]),
    ...(summary.mean_output_tokens === undefined
      ? []
      : [`- Mean output tokens: ${summary.mean_output_tokens.toFixed(0)}`]),
    ...(summary.human_approval_rate === undefined
      ? []
      : [`- Human mission approval: ${percent(summary.human_approval_rate)}`]),
    ...(summary.defects_found === undefined
      ? []
      : [`- Evidence-linked defects: ${summary.defects_found}`]),
    ...(summary.unique_defects_found === undefined
      ? []
      : [`- Defects unique to model proposals: ${summary.unique_defects_found}`]),
    "",
    ...(summary.human_approval_rate === undefined
      ? [
          "Human approval rate and defect yield are intentionally absent until a reviewer labels runs.",
        ]
      : []),
    "",
    "| Case | Run | Status | Pass | Recall | Precision | Missing | Unsupported |",
    "| --- | ---: | --- | --- | ---: | ---: | --- | --- |",
    ...rows,
    "",
  ].join("\n")}\n`;
}
