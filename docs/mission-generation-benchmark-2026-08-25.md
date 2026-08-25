# Mission-generation model benchmark — 2026-08-25

## Decision

Use **no LLM** for mission generation. The trust-critical verification path continues to use the
deterministic `intent-heuristics@1` generator and deterministic repository QA adapters.

The comparison found no executable model advantage. Repository adapters dispatch concrete browser
actions by approved mission identity; model-authored titles and objectives are descriptive only.
The prompt also preserves those behavior IDs and generates risk IDs without knowing adapter
capabilities. As a result, it can paraphrase an existing journey or propose an unsupported one, but
it cannot create a new executable journey. Cost-ranking those outputs is not a product-model
selection.

All three candidates cleared every automated text-quality and cache gate. Luna had the lowest realized
cost at $0.000441 per run. Terra was 27% faster than Luna but cost 8.1 times as much. Sol produced no
measurable quality gain, was the slowest candidate, and cost 16.3 times as much as Luna. These are
automated results on a small corpus. Luna is therefore the cheapest measured candidate, not a
recommendation. Any future selection requires an adapter-declared executable scenario vocabulary
and an evidence-linked defect not already found by deterministic verification.
The checked-in policy marks this corpus `research_only`; the selector cannot promote a model from
these artifacts, even if review fields are later populated.

## Controlled comparison

- API: OpenAI Responses API with strict Structured Outputs and `store: false`.
- Models: exact `gpt-5.6-terra`, `gpt-5.6-sol`, and `gpt-5.6-luna` identifiers.
- Reasoning: medium for every candidate.
- Corpus: eight intent-only contracts, three independent repetitions each, 24 runs per model.
- Suite SHA-256: `39e09555fc45b11cf74911035236b83ddcb92c34c4579eaebc09116c064c4fd0`.
- Scorer: `executable-trust-layer/mission-evaluator@1`.
- Prompt: checked-in `prompt-v2.md`, SHA-256
  `75673ffecac64e9f3d6cfa8a79eeccd9fc48e5ed74ce94dc11a66bc7bbccb16e`.
- Prompt caching: explicit breakpoint after the stable developer rubric, SHA-derived cache key,
  30-minute TTL, and dynamic contract input after the breakpoint.
- Request policy: `openai-responses`, `store: false`, one attempt, 60-second timeout, 4,000 output
  tokens, 128 KiB prompt, 64 KiB contract input, and 20 missions per case.
- Inputs: approved-intent fields only; no implementation narrative, source code, credentials, URLs,
  or QA adapter implementation.
- Prices: OpenAI standard, short-context rates checked on 2026-08-25. Realized cost applies the
  measured ordinary-input, cache-read, cache-write, and output token classes and excludes
  regional-processing uplifts.

| Candidate       | Hard pass | Recall/precision | Stability | Cache hit/write | Mean latency | Mean tokens input/cached/write/output | Realized cost/run | Cost/24 runs |
| --------------- | --------: | ---------------: | --------: | --------------: | -----------: | ------------------------------------: | ----------------: | -----------: |
| `gpt-5.6-terra` |    100.0% |  100.0% / 100.0% |    100.0% |    87.9% / 3.8% |     3,537 ms |              1,572 / 1,382 / 60 / 240 |         $0.003572 |    $0.085724 |
| `gpt-5.6-sol`   |    100.0% |  100.0% / 100.0% |    100.0% |    87.9% / 3.8% |     5,475 ms |              1,572 / 1,382 / 60 / 291 |         $0.007204 |    $0.172892 |
| `gpt-5.6-luna`  |    100.0% |  100.0% / 100.0% |    100.0% |    87.9% / 3.8% |     4,873 ms |              1,572 / 1,382 / 60 / 310 |         $0.000441 |    $0.010584 |

Each model's first request wrote 1,442 cacheable tokens and its next 23 requests read that prefix.
Realized cost applies OpenAI's GPT-5.6 cache-write and cache-read multipliers to the measured token
classes rather than charging every input token at the uncached rate.

Candidate SHA-256 digests: Terra
`a331b98213cc858be74a91aacc2711ec6252d8c76beaf632733ccabfcb0221b4`, Sol
`a053335af230d9579a3be998fcf3955caf8bf632a6e64d1fe02b9d5faaeabe23`, and Luna
`f2bb2856626966a650a07f5f1e00b75894bb700218f79396046d832e4f2b61b6`.

## What the evaluation establishes

All three models returned schema-valid output, preserved complete provider/model/prompt/input
provenance, resisted the instruction embedded in hostile contract text, grounded every emitted risk
label in the contract, and preserved every behavior and canonical risk-boundary ID in all 24 runs.
The prompt-cache gate also passed for every model.

The corpus initially overfit optional mission IDs and deterministic risk taxonomy. A preflight smoke
run exposed that it rejected sensible risk-grounded boundaries. Before the controlled comparison,
the scorer was corrected to accept extra missions only when both `risk` and `derived_from` exactly
bind a declared risk; required behavior and canonical risk IDs, provenance, duplicates, output
budget, and repeated-set stability remain strict. Prompt v2 adds stable interpretation rules,
self-checks, and worked examples. That eliminated Luna's earlier naming miss while leaving the model
to write observable titles and objectives.

## What remains unproven

This is a small synthetic regression corpus, not evidence of production defect yield. More
fundamentally, its mission prose is not an executable input to the repository adapter. No candidate
has demonstrated a unique defect beyond the deterministic baseline, and latency is a point-in-time
measurement from one region. Model safeguards, availability, and prices can change. Therefore:

1. keep production verification deterministic;
2. do not ask reviewers to classify the synthetic packets as if wording changed execution;
3. define a constrained, adapter-declared executable scenario vocabulary before another model pilot;
4. require executed historical incidents, human review, and unique defect yield before selection; and
5. rerun the benchmark whenever the prompt, model, corpus, rates, or selection thresholds change.

Sources: [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model),
[prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching),
[pricing](https://developers.openai.com/api/docs/pricing), and
[evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
