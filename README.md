# Executable Trust Layer

A working local-first prototype for reviewing approved intent and concrete evidence instead of routinely reviewing agent-generated diffs.

The central question is: **given this approved change contract and the resulting implementation, what must be proven before the change can be trusted?**

## Core loop

```text
repository -> discovery -> trust.yaml
approved intent -> change contract
changed files + risks + surfaces -> selective verification plan
checks + invariants + independent browser QA -> evidence
evidence -> terminal / JSON / Markdown trust report
finding or incident -> approval-required learning proposal
```

## Try it

```bash
pnpm install
pnpm exec playwright install chromium

pnpm trust init examples/demo-app --no-write
pnpm trust plan examples/demo-app/change-contract.yaml \
  --config examples/demo-app/trust.yaml \
  --changed src/worker.ts,src/client.tsx

pnpm demo:prove
```

`demo:prove` runs the same approved contract against two isolated local D1 previews. In the broken variant the static, unit, bundle, native Playwright, request, and CLI evidence passes, but independent browser/device missions discover that retrying and racing the invitation mutation creates duplicate pending invitations. The fixed variant uses a D1 uniqueness invariant and conflict-safe Drizzle insertion, then passes the same full matrix. Reports and screenshots are written beneath `examples/demo-app/.trust/runs/`.

## CLI

```text
trust init [repository]       discover verification and generate trust YAML
trust doctor                  validate policy references and adapter readiness
trust inspect [repository]    print discovery and the configured graph
trust plan <contract>         validate intent and select relevant evidence
trust verify                  execute selected checks, invariants, and QA
trust report <report.json>    render terminal, Markdown, or JSON output
trust learn <report.json>     propose reusable verification improvements
trust learn-incident <file>   turn an incident model into proposals
```

## Production verifier matrix

Repository policy can select six independently evidenced execution surfaces:

- **command checks** integrate typecheckers, linters, tests, security tools, and builds;
- **custom invariants** measure repository-specific budgets against baselines and thresholds;
- **native Playwright** runs existing deterministic browser suites against the supplied preview;
- **request contracts** execute bounded HTTP probes with status, body, and JSON-path assertions;
- **CLI missions** spawn explicit executables without a shell and assert exit/output contracts;
- **browser and device agents** derive journeys from approved intent, run through repository adapters, and capture screenshots, browser errors, response failures, URLs, and visible outcomes.

Every adapter is selected through the same changed-file, surface, dependency, risk, and contract graph. `trust doctor` rejects duplicate evidence IDs, dangling surface dependencies, unknown requirements, missing agent adapters, and missing local Playwright executables before a run starts.

See [the specification](docs/specification.md), [architecture](docs/architecture.md), and the [demo contract](examples/demo-app/change-contract.yaml).

## Prototype evaluation

1. **Unfamiliar repository discovery:** useful for package metadata, scripts, languages, common frameworks, CI, docs, ADRs, entry points, routes, and workspaces. It deliberately reports gaps where ownership or thresholds cannot be safely inferred.
2. **Intent without manual command mapping:** the contract names behavior, surfaces, risk, and evidence. Repository policy supplies commands once.
3. **Selective verification:** the graph selects by changed paths, product surface, dependencies, risk tags, and explicit contract evidence; the report preserves selection reasons.
4. **Independent QA:** missions come from intent and risk heuristics, not implementation narration. The demo proves QA catches a behavior ordinary tests miss.
5. **Report as review surface:** terminal, JSON, and PR-ready Markdown expose claims, evidence, unknowns, artifacts, thresholds, and verdict.
6. **Reusable learning:** failures and incidents become proposed knowledge, heuristics, regression tests, or invariants. Nothing is silently promoted.
7. **Hosted boundary:** preview provisioning, parallel/browser compute, persistent organizational knowledge, incident ingestion, cross-repository analysis, integrations, and evidence retention.
8. **Open/local boundary:** config and contract specifications, discovery, graph semantics, invariant SDK, local runner, basic QA, and reporters.

This prototype does not claim that every routine diff can already be ignored. It demonstrates the narrower product thesis: where policy and evidence are complete, the system can produce auditable reasons to trust; where they are incomplete, it says so explicitly.
