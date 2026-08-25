import { describe, expect, it } from "vitest";
import {
  applyMissionEvalReview,
  createMissionEvalReview,
  deterministicMissionCandidate,
  missionModelSelectionPolicySchema,
  missionEvalSuiteSchema,
  renderMissionEvalReviewMarkdown,
  renderMissionModelDecisionMarkdown,
  renderMissionEvalMarkdown,
  scoreMissionEval,
  selectMissionProposalModel,
  type MissionEvalCandidate,
  type MissionModelReport,
} from "../packages/evals/src/index.js";
import { readFile } from "node:fs/promises";
import { missionPromptCacheKey, openAIMissionRequest } from "../scripts/openai-mission-request.js";

async function suite() {
  return missionEvalSuiteSchema.parse(
    JSON.parse(await readFile("evals/mission-generation/suite.v1.json", "utf8")),
  );
}

async function modelPolicy() {
  return missionModelSelectionPolicySchema.parse(
    JSON.parse(await readFile("evals/mission-generation/model-selection-policy.v1.json", "utf8")),
  );
}

describe("mission generation evaluations", () => {
  it("keeps the deterministic baseline reproducible and fully passing", async () => {
    const input = await suite();
    const candidate = deterministicMissionCandidate(input);
    const report = scoreMissionEval(input, candidate);
    expect(report.summary).toMatchObject({
      valid_output_rate: 1,
      hard_pass_rate: 1,
      required_recall: 1,
      allowed_precision: 1,
      provenance_rate: 1,
      human_reviewed_runs: 0,
    });
    expect(report.summary.human_approval_rate).toBeUndefined();
    expect(renderMissionEvalMarkdown(report)).toContain(
      "Human approval rate and defect yield are intentionally absent",
    );
  });

  it("penalizes missing, unsupported, duplicate, and failed model output", async () => {
    const input = await suite();
    const modelCandidate = {
      version: 1,
      id: "bad-model",
      kind: "model",
      generator: "executable-trust-layer/mission-proposer",
      generator_version: "1",
      provider: "openai",
      model: "example-model",
      reasoning_effort: "medium",
      prompt_sha256: "b".repeat(64),
      prompt_cache: {
        key: `mission-v3:${"b".repeat(52)}`,
        mode: "explicit",
        ttl: "30m",
      },
      request_policy: {
        api: "openai-responses",
        store: false,
        max_output_tokens: 4_000,
        timeout_ms: 60_000,
        max_prompt_bytes: 128 * 1024,
        max_input_bytes: 64 * 1024,
        max_missions_per_case: 20,
        attempts: 1,
      },
      repetitions: 1,
      runs: [
        {
          case_id: "team-invitations",
          repetition: 1,
          status: "valid",
          missions: [
            {
              id: "happy-path",
              title: "Invite",
              objective: "Invite",
              derived_from: ["happy-path"],
              viewport: "desktop",
              generation: {
                method: "model",
                generator: "wrong-generator",
                version: "1",
                input_sha256: "a".repeat(64),
                provider: "openai",
                model: "example-model",
                prompt_sha256: "b".repeat(64),
              },
            },
            {
              id: "invented-secret-export",
              title: "Invented",
              objective: "Invented",
              derived_from: ["nothing"],
              viewport: "desktop",
              generation: {
                method: "model",
                generator: "wrong-generator",
                version: "1",
                input_sha256: "a".repeat(64),
                provider: "openai",
                model: "example-model",
                prompt_sha256: "b".repeat(64),
              },
            },
            {
              id: "happy-path",
              title: "Duplicate",
              objective: "Duplicate",
              derived_from: ["happy-path"],
              viewport: "desktop",
              generation: {
                method: "model",
                generator: "wrong-generator",
                version: "1",
                input_sha256: "a".repeat(64),
                provider: "openai",
                model: "example-model",
                prompt_sha256: "b".repeat(64),
              },
            },
          ],
        },
        {
          case_id: "refund-webhooks",
          repetition: 1,
          status: "refused",
          reason: "refused",
        },
      ],
    } satisfies MissionEvalCandidate;
    const report = scoreMissionEval(input, modelCandidate);
    expect(report.summary.hard_pass_rate).toBe(0);
    expect(report.summary.valid_output_rate).toBe(0.125);
    expect(report.runs[0]).toMatchObject({
      duplicate_count: 1,
      unsupported_mission_ids: ["invented-secret-export"],
      provenance_complete: false,
    });
    expect(report.runs[0]!.missing_required_mission_ids).toContain("risk-mobile-ui");
    expect(report.runs[1]).toMatchObject({ status: "refused", required_recall: 0 });
    expect(report.runs).toHaveLength(input.cases.length);
    expect(report.runs.at(-1)).toMatchObject({
      status: "error",
      reason: "Candidate omitted this required evaluation run.",
    });
  });

  it("keeps model proposals disabled when benchmark or human evidence is missing", async () => {
    const decision = selectMissionProposalModel(await modelPolicy(), []);
    expect(decision).toMatchObject({
      status: "insufficient_evidence",
      production_mission_generation: "deterministic",
      proposal_model: null,
      automated_recommendation: null,
    });
    expect(decision.candidates).toHaveLength(3);
    expect(decision.candidates.every((candidate) => !candidate.eligible)).toBe(true);
    expect(renderMissionModelDecisionMarkdown(decision)).toContain(
      "Selected proposal model: **none**",
    );
  });

  it("does not recommend a schema-valid model before operational evidence exists", async () => {
    const report = {
      version: 1,
      suite_id: "mission-generation-v1",
      suite_sha256: "39e09555fc45b11cf74911035236b83ddcb92c34c4579eaebc09116c064c4fd0",
      candidate_sha256: "b".repeat(64),
      scorer: {
        name: "executable-trust-layer/mission-evaluator",
        version: "1",
      },
      candidate: {
        id: "gpt-5.6-luna-medium",
        kind: "model",
        provider: "openai",
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
      },
      summary: {
        total_runs: 24,
        valid_output_rate: 1,
        hard_pass_rate: 1,
        required_recall: 1,
        allowed_precision: 1,
        risk_accuracy: 1,
        provenance_rate: 1,
        stability: 1,
        human_reviewed_runs: 0,
        mean_latency_ms: 1_000,
        mean_input_tokens: 1_200,
        mean_cached_input_tokens: 1_000,
        mean_cache_write_input_tokens: 50,
        prompt_cache_hit_rate: 5 / 6,
        prompt_cache_write_rate: 1 / 24,
        mean_output_tokens: 100,
      },
    } satisfies MissionModelReport;
    const researchDecision = selectMissionProposalModel(await modelPolicy(), [report]);
    expect(researchDecision).toMatchObject({
      status: "insufficient_evidence",
      proposal_model: null,
      automated_recommendation: null,
    });
    expect(researchDecision.candidates[2]!.review_reasons.join(" ")).toContain(
      "research-only",
    );
    const decision = selectMissionProposalModel(
      { ...(await modelPolicy()), evaluation_mode: "executed_pilot" },
      [report],
    );
    expect(decision).toMatchObject({
      status: "insufficient_evidence",
      proposal_model: null,
      automated_recommendation: null,
    });
    expect(decision.candidates[2]).toMatchObject({ automated_eligible: true, eligible: false });
    expect(renderMissionModelDecisionMarkdown(decision)).toContain(
      "Automated text-quality and cost checks are not evidence of executable coverage",
    );
  });

  it("selects only a candidate that clears automated, operational, and human gates", async () => {
    const report = {
      version: 1,
      suite_id: "mission-generation-v1",
      suite_sha256: "39e09555fc45b11cf74911035236b83ddcb92c34c4579eaebc09116c064c4fd0",
      candidate_sha256: "b".repeat(64),
      scorer: {
        name: "executable-trust-layer/mission-evaluator",
        version: "1",
      },
      candidate: {
        id: "gpt-5.6-terra-medium",
        kind: "model",
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
      summary: {
        total_runs: 24,
        valid_output_rate: 1,
        hard_pass_rate: 0.96,
        required_recall: 1,
        allowed_precision: 0.99,
        risk_accuracy: 0.96,
        provenance_rate: 1,
        stability: 0.97,
        human_reviewed_runs: 24,
        human_approval_rate: 0.92,
        defects_found: 2,
        unique_defects_found: 1,
        mean_latency_ms: 12_000,
        mean_input_tokens: 400,
        mean_cached_input_tokens: 300,
        mean_cache_write_input_tokens: 25,
        prompt_cache_hit_rate: 0.75,
        prompt_cache_write_rate: 0.0625,
        mean_output_tokens: 700,
      },
    } satisfies MissionModelReport;
    const decision = selectMissionProposalModel(
      { ...(await modelPolicy()), evaluation_mode: "executed_pilot" },
      [report],
    );
    expect(decision).toMatchObject({
      status: "selected",
      production_mission_generation: "deterministic",
      proposal_model: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
      automated_recommendation: {
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
    });
    expect(decision.candidates[0]).toMatchObject({ eligible: true });
    expect(decision.candidates[0]!.estimated_cost_per_run_usd).toBeCloseTo(0.0086725);
    expect(decision.candidates[1]).toMatchObject({ eligible: false });
  });

  it("places a stable explicit cache breakpoint before dynamic contract input", () => {
    const digest = "a".repeat(64);
    const request = openAIMissionRequest({
      model: "gpt-5.6-terra",
      reasoningEffort: "medium",
      prompt: "stable rubric",
      promptSha256: digest,
      input: { id: "dynamic-contract" },
      outputSchema: { type: "object" },
    });
    expect(missionPromptCacheKey(digest)).toBe(`mission-v3:${digest.slice(0, 52)}`);
    expect(request).toMatchObject({
      max_output_tokens: 4_000,
      store: false,
      prompt_cache_key: `mission-v3:${digest.slice(0, 52)}`,
      prompt_cache_options: { mode: "explicit", ttl: "30m" },
      input: [
        {
          role: "developer",
          content: [{ prompt_cache_breakpoint: { mode: "explicit" } }],
        },
        { role: "user" },
      ],
    });
  });

  it("fails the automated model gate when measured prompt-cache reuse is too low", async () => {
    const policy = await modelPolicy();
    const report = {
      version: 1,
      suite_id: "mission-generation-v1",
      suite_sha256: "39e09555fc45b11cf74911035236b83ddcb92c34c4579eaebc09116c064c4fd0",
      candidate_sha256: "b".repeat(64),
      scorer: {
        name: "executable-trust-layer/mission-evaluator",
        version: "1",
      },
      candidate: {
        id: "gpt-5.6-terra-medium",
        kind: "model",
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
      summary: {
        total_runs: 24,
        valid_output_rate: 1,
        hard_pass_rate: 1,
        required_recall: 1,
        allowed_precision: 1,
        risk_accuracy: 1,
        provenance_rate: 1,
        stability: 1,
        human_reviewed_runs: 24,
        human_approval_rate: 1,
        defects_found: 1,
        unique_defects_found: 1,
        mean_latency_ms: 1_000,
        mean_input_tokens: 1_200,
        mean_cached_input_tokens: 100,
        mean_cache_write_input_tokens: 50,
        prompt_cache_hit_rate: 1 / 12,
        prompt_cache_write_rate: 1 / 24,
        mean_output_tokens: 100,
      },
    } satisfies MissionModelReport;
    const decision = selectMissionProposalModel(policy, [report]);
    expect(decision.candidates[0]).toMatchObject({
      automated_eligible: false,
    });
    expect(decision.candidates[0]!.automated_reasons.join(" ")).toContain("Prompt cache hit rate");
  });

  it("rejects a report scored against a suite digest outside policy", async () => {
    const report = {
      version: 1,
      suite_id: "mission-generation-v1",
      suite_sha256: "f".repeat(64),
      candidate_sha256: "b".repeat(64),
      scorer: {
        name: "executable-trust-layer/mission-evaluator",
        version: "1",
      },
      candidate: {
        id: "gpt-5.6-terra-medium",
        kind: "model",
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning_effort: "medium",
      },
      summary: {
        total_runs: 24,
        valid_output_rate: 1,
        hard_pass_rate: 1,
        required_recall: 1,
        allowed_precision: 1,
        risk_accuracy: 1,
        provenance_rate: 1,
        stability: 1,
        human_reviewed_runs: 24,
        human_approval_rate: 1,
        defects_found: 1,
        unique_defects_found: 1,
        mean_latency_ms: 1_000,
        mean_input_tokens: 1_200,
        mean_cached_input_tokens: 1_000,
        mean_cache_write_input_tokens: 50,
        prompt_cache_hit_rate: 5 / 6,
        prompt_cache_write_rate: 1 / 24,
        mean_output_tokens: 100,
      },
    } satisfies MissionModelReport;
    const decision = selectMissionProposalModel(await modelPolicy(), [report]);
    expect(decision.candidates[0]!.automated_reasons).toContain(
      "Report suite digest does not match the model-selection policy.",
    );
  });

  it("rejects incomplete or overlapping human review labels", async () => {
    const input = await suite();
    const candidate = deterministicMissionCandidate(input);
    const first = candidate.runs[0];
    if (!first || first.status !== "valid") throw new Error("Expected a valid baseline run.");
    first.human_review = {
      reviewer: "product-owner",
      reviewed_at: "2026-08-25T12:00:00.000Z",
      approved_mission_ids: [first.missions[0]!.id],
      rejected_mission_ids: [first.missions[0]!.id],
      defects: [],
    };
    expect(() => scoreMissionEval(input, candidate)).toThrow(/Human review/);
  });

  it("exports and applies a complete digest-bound human review", async () => {
    const input = await suite();
    const candidate = deterministicMissionCandidate(input);
    const review = createMissionEvalReview(input, candidate);
    expect(review.review_id).toMatch(/^[a-f0-9]{16}$/);
    expect(review.runs.every((run) => run.missions.every((mission) => !mission.generation))).toBe(
      true,
    );
    expect(renderMissionEvalReviewMarkdown(review)).toContain("Classified missions: 0/");
    review.reviewer = "product-owner";
    review.reviewed_at = "2026-08-25T12:00:00.000Z";
    for (const run of review.runs) {
      for (const decision of run.decisions) decision.verdict = "approved";
      run.defects = [];
    }
    review.runs[0]!.defects = [
      {
        id: "duplicate-invitation",
        summary: "A repeated invitation created duplicate pending records.",
        evidence: ["report:broken-demo#qa:duplicate-submission"],
        also_found_by_deterministic: false,
      },
    ];
    const reviewed = applyMissionEvalReview(input, candidate, review);
    const report = scoreMissionEval(input, reviewed);
    expect(report.summary).toMatchObject({
      human_reviewed_runs: input.cases.length,
      human_approval_rate: 1,
      defects_found: 1,
      unique_defects_found: 1,
    });
    expect(reviewed.runs[0]).toMatchObject({
      human_review: {
        reviewer: "product-owner",
        reviewed_at: "2026-08-25T12:00:00.000Z",
      },
    });
  });

  it("rejects stale or incomplete human-review artifacts", async () => {
    const input = await suite();
    const candidate = deterministicMissionCandidate(input);
    const review = createMissionEvalReview(input, candidate);
    review.reviewer = "product-owner";
    review.reviewed_at = "2026-08-25T12:00:00.000Z";
    for (const run of review.runs) {
      for (const decision of run.decisions) decision.verdict = "approved";
      run.defects = [];
    }
    review.candidate_sha256 = "f".repeat(64);
    expect(() => applyMissionEvalReview(input, candidate, review)).toThrow(/digest/);
    const freshReview = createMissionEvalReview(input, candidate);
    freshReview.reviewer = "product-owner";
    freshReview.reviewed_at = "2026-08-25T12:00:00.000Z";
    for (const run of freshReview.runs) {
      for (const decision of run.decisions) decision.verdict = "approved";
      run.defects = [];
    }
    freshReview.runs[0]!.contract = {};
    expect(() => applyMissionEvalReview(input, candidate, freshReview)).toThrow(/contract content/);
    const incompleteReview = createMissionEvalReview(input, candidate);
    incompleteReview.reviewer = "product-owner";
    incompleteReview.reviewed_at = "2026-08-25T12:00:00.000Z";
    for (const run of incompleteReview.runs) {
      for (const decision of run.decisions) decision.verdict = "approved";
      run.defects = [];
    }
    incompleteReview.runs[0]!.decisions[0]!.verdict = null;
    expect(() => applyMissionEvalReview(input, candidate, incompleteReview)).toThrow(
      /unclassified/,
    );
  });

  it("rejects forged deterministic input provenance and unsupported risk labels", async () => {
    const input = await suite();
    const candidate = deterministicMissionCandidate(input);
    const first = candidate.runs[0];
    if (!first || first.status !== "valid") throw new Error("Expected a valid baseline run.");
    first.missions[0]!.generation!.input_sha256 = "f".repeat(64);
    first.missions[0]!.risk = "invented risk";
    const report = scoreMissionEval(input, candidate);
    expect(report.runs[0]).toMatchObject({
      hard_pass: false,
      provenance_complete: false,
    });
    expect(report.runs[0]!.risk_accuracy).toBeLessThan(1);
  });
});
