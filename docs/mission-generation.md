# QA mission generation

## Current production path

The trust-critical path uses no LLM. `intent-heuristics@1` deterministically maps each approved
behavior to a mission and adds risk-derived boundary missions, such as a constrained mobile journey.
The repository-owned adapter translates those abstract objectives into concrete Playwright actions.
`contract:init` stores the generated missions in the draft change contract. The approval signature
therefore binds the exact mission set, its inputs, and generator provenance; verification does not
regenerate an approved mission artifact.

Every mission records:

- `method`: `deterministic` or `model`;
- generator name and version;
- SHA-256 digest of the exact generation input; and
- for model output, provider, exact model, and prompt SHA-256.

Reports render this provenance so a reviewer can distinguish model judgment, deterministic planning,
and repository-authored execution. The generator never receives the implementation agent's narrative.

Mission generation and browser execution are separate. Repository policy declares executor
provenance: deterministic or model-driven, adapter name and version, and—when applicable—provider,
exact model, and prompt digest. Each QA evidence item copies that policy-bound identity. The demo uses the deterministic
`trust-demo/playwright-journeys@1` adapter; it does not currently use an LLM to control the browser.

## Why a model is not in the verification loop

Calling a mutable model during verification would make mission selection non-reproducible and would
quietly add the provider, prompt, and sampling behavior to the trust root. A stronger boundary is:

```text
draft intent -> model proposes missions -> schema validation -> human approval
            -> immutable mission artifact -> deterministic execution -> signed report
```

The current model does not expand executable test behavior. A repository adapter decides support and
concrete actions from the approved mission identity; title and objective are review prose. In the
bundled demo, changing that prose cannot change a selector, request, assertion, or navigation. An
additional model-generated ID is also useless unless the adapter already implements it, in which
case the test capability came from repository code rather than the model. This makes the current
mission-proposal task a paraphrasing layer, not a source of testing power.

A future model may expand test ideas only after the product defines a constrained, adapter-declared
scenario vocabulary whose validated parameters affect execution. It still must not approve intent,
decide the final verdict, or hold reporter authority. A rejected, malformed, unsupported, or
unapproved proposal remains `not_verified`.
Model proposals can be placed in the draft contract's `qa_missions` only with complete generation
provenance, then reviewed and signed through the normal contract approval flow.

## Model evaluation result and future plan

The product currently selects no LLM. A controlled comparison tested `gpt-5.6-terra`,
`gpt-5.6-sol`, and `gpt-5.6-luna` with medium reasoning through the Responses API, strict structured
output, `store: false`, and no source code beyond approved intent. All three passed the synthetic
text contract; none demonstrated additional executable coverage or defect yield.

Do not select a model by anecdote. Build an evaluation corpus from approved contracts plus known
incidents, then score:

1. behavior coverage and boundary-condition recall;
2. unique defects caught beyond existing deterministic evidence;
3. unsupported or hallucinated journey rate;
4. repository-adapter support rate;
5. stability across repeated runs;
6. human edit and rejection rate; and
7. latency, tokens, and cost per approved useful mission.

The model wins only if its additional defect yield justifies its false-positive rate, review cost,
latency, and data boundary. Record the exact model identifier and prompt digest in every evaluation
and approved proposal; never rely on an unrecorded mutable alias.

The first controlled Terra/Sol/Luna comparison is recorded in the
[2026-08-25 benchmark](mission-generation-benchmark-2026-08-25.md). Luna with medium reasoning was
the cheapest schema-compliant candidate, but that is not a model recommendation. Production and
proposal generation remain deterministic unless a future executable pilot demonstrates unique
defect yield.

### Reproducible benchmark

The published package and source repository include an eight-case, intent-only corpus covering
authorization, idempotency, money movement, migrations, retries, expiration, mobile UI,
localization, regressions, and prompt injection inside untrusted contract text. Run the deterministic
control with:

```bash
pnpm eval:missions
```

The scorer requires a complete case-by-repetition matrix and counts omitted, invalid, refused, or
errored runs as failures. It measures required-mission recall, risk-grounded mission precision, risk
grounding, duplicates, provenance, output budget, and repeated-run Jaccard stability. Latency
and token counts are carried through when a provider reports them. Human approval and defects found
remain absent until a reviewer explicitly labels each run; they are never inferred from model
output.

The deterministic `intent-heuristics@1` control currently passes all eight cases with 100% required
recall, precision, risk accuracy, provenance completeness, and hard-pass rate. This is a regression
control, not evidence that the corpus predicts production defect yield: the expected labels were
written against the product's declared mission contract.

From a source checkout, collect a model candidate by setting `OPENAI_API_KEY` in the invoking
environment and choosing the exact model explicitly. The credentialed runner is deliberately not a
runtime dependency of the trust CLI:

```bash
pnpm eval:missions:model -- \
  --model gpt-5.6-terra \
  --reasoning-effort medium \
  --repetitions 3

pnpm eval:missions -- \
  --candidate .trust/evals/mission-generation/gpt-5.6-terra.candidate.json
```

Repeat the first command for `gpt-5.6-sol` and `gpt-5.6-luna`. The runner uses the Responses API,
strict structured output, `store: false`, and sends only the intent contract—not source code,
implementation narration, credentials, or QA adapter details. Candidate files use owner-only
permissions, exclude the API key, preserve response IDs and parsed mission artifacts, and bind the
exact prompt and input digests. Generated results live under ignored `.trust/evals/`; publish only
deliberately reviewed, redacted comparisons.

The credentialed boundary caps the stable prompt at 128 KiB, each contract input at 64 KiB, each
case at 20 missions, and each response at 4,000 output tokens. Requests abort after 60 seconds.
Evaluation calls are deliberately not retried: a refusal, timeout, rate limit, or provider failure
remains a failed run instead of being hidden by a later attempt.

For GPT-5.6 candidates, the runner uses explicit prompt caching rather than relying on an accidental
shared prefix. Prompt v2 contains a useful stable rubric and examples above the 1,024-token cacheable
minimum. A SHA-derived `prompt_cache_key` and explicit breakpoint bind the reusable developer
content; changing contract data is appended afterward. The request uses the 30-minute TTL and records
`cached_tokens` plus `cache_write_tokens` for every response. The scorer reports aggregate token hit
and write rates, and the selection policy fails candidates below 50% measured reuse. Do not pad a
short prompt with irrelevant text merely to cross the threshold.

### Executed-pilot review workflow

Export a review packet from an unchanged candidate artifact:

```bash
pnpm eval:missions:review -- \
  --candidate .trust/evals/mission-generation/gpt-5.6-luna-medium.candidate.json
```

Do not review the synthetic benchmark packets as a substitute for product execution. First run the
candidate missions against a repository adapter and the deterministic control. Then the command
prints the path of an owner-only `review-<opaque-id>.json` worksheet and Markdown
rendering. The packet contains the exact intent input, proposed mission content, candidate SHA-256,
and empty review fields, but strips generator/provider/model provenance to reduce reviewer brand
bias. A product reviewer must set `reviewer` and `reviewed_at`, classify every mission as `approved`
or `rejected`, and record an explicit `defects` array for every run. Each defect requires a stable
ID, summary, evidence reference, and `also_found_by_deterministic` classification. Defects count only
when executing the proposed mission exposes an observed product defect; a plausible mission
description alone is not a defect.

Apply the completed worksheet without overwriting the raw candidate, then rescore it:

```bash
pnpm eval:missions:review -- \
  --candidate .trust/evals/mission-generation/gpt-5.6-luna-medium.candidate.json \
  --apply .trust/evals/mission-generation/review-REVIEW_ID.json

pnpm eval:missions -- \
  --candidate .trust/evals/mission-generation/gpt-5.6-luna-medium.reviewed.candidate.json
```

Application fails closed if the suite, candidate digest, displayed contract, displayed mission
content, run matrix, or mission IDs differ; if any decision or defect classification is missing; or
if the completion timestamp is in the future. Review
identity is calibration metadata, not a cryptographic production approval. Promotion still requires
the normal signed change-contract authority flow.

For research comparison, pass reviewed candidate artifacts to the current policy without requesting
selection:

```bash
pnpm eval:missions:select -- \
  --candidate .trust/evals/mission-generation/gpt-5.6-terra-medium.reviewed.candidate.json \
  --candidate .trust/evals/mission-generation/gpt-5.6-sol-medium.reviewed.candidate.json \
  --candidate .trust/evals/mission-generation/gpt-5.6-luna-medium.reviewed.candidate.json
```

The selector recomputes every score from the policy-pinned suite digest and digest-bound candidate;
it does not trust editable summary metrics. `--report` remains available for exploratory comparison,
but `--require-selection` rejects report-only input. With the checked-in `research_only` policy,
`--require-selection` also exits nonzero by design. A future executed pilot must supply its own
digest-pinned policy with `--policy`, set `evaluation_mode` to `executed_pilot`, and then use
`--require-selection`.

The checked-in policy requires complete structured output, 100% required recall and provenance,
at least 98% precision, 95% hard-pass/risk/stability scores, 24 fully classified human-reviewed
runs, at least 90% mission approval, mean latency no higher than 30 seconds, at least one
evidence-linked defect not also found by deterministic verification, and at least a 50% measured
prompt-cache token-hit rate. Missing reports or metrics are failures. Among eligible candidates,
unique observed defect yield and human approval win first; quality, stability, realized cache-aware
cost, and latency break ties. Prices and cache-read/write multipliers
are snapshotted in the checked-in policy with their source and check date so comparisons are
reproducible. Refresh that snapshot from the provider before making a new decision.
Regardless of the winner, model output remains a pre-approval proposal and the production
verification path stays deterministic.

The current policy is explicitly `research_only`, so it cannot select a model even if someone fills
the synthetic review fields. A future pilot must introduce a new digest-pinned suite and set
`evaluation_mode` to `executed_pilot` only after its model-authored, validated scenario parameters
actually affect repository-adapter execution.

Do not promote a winner from automated scores alone. Calibrate the labels with product reviewers,
add historical incident contracts, run each candidate repeatedly, and compare defect yield plus
review edits against latency, tokens, and price. OpenAI's evaluation guidance likewise recommends
task-specific datasets, automated scoring calibrated by humans, and logging at the nondeterministic
boundary. The legacy hosted Evals platform is scheduled for shutdown in November 2026, so this
benchmark deliberately remains provider-neutral and local.

OpenAI's current model guidance describes `gpt-5.6-sol` as the flagship model, `gpt-5.6-terra` as the
balanced option, and `gpt-5.6-luna` as the efficient high-volume option. It recommends the Responses
API and intentionally benchmarking reasoning effort on representative tasks:
<https://developers.openai.com/api/docs/guides/latest-model>.

References: [evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices),
[Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching), and
[Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
