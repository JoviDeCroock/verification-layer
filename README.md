# Executable Trust Layer

A local-first executable trust authority for reviewing approved intent and concrete evidence instead
of trusting implementation narratives or undifferentiated test output.

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

pnpm trust setup . --approver product-owner --reporter ci
pnpm trust schema:export
pnpm trust doctor --config trust.yaml
pnpm trust contract:init change-contract.yaml \
  --config trust.yaml \
  --intent "Describe the user-visible outcome" \
  --surface application
pnpm trust contract:approve change-contract.yaml \
  --config trust.yaml \
  --by product-owner \
  --key .trust/keys/approver.private.pem
pnpm trust policy:digest --config trust.yaml
pnpm trust ci:init --config trust.yaml --contract change-contract.yaml --report-signer ci \
  --authority-package @your-org/executable-trust@1.0.0

pnpm demo:prove
```

`setup` never overwrites policy or keys. It creates distinct, expiring approver and reporter
identities with owner-only private-key permissions and strict execution defaults. Review discovered
shell checks before explicitly enabling them; a new policy intentionally fails `doctor` until every
required adapter and authority decision is ready. `trust doctor --format json` exposes the same
readiness result, counts, warnings, and blockers as a stable machine-readable contract.

`demo:prove` runs the same approved contract against two isolated local D1 previews. In the broken variant the static, unit, bundle, native Playwright, request, and CLI evidence passes, but independent browser/device missions discover that retrying and racing the invitation mutation creates duplicate pending invitations. The fixed variant uses a D1 uniqueness invariant and conflict-safe Drizzle insertion, then passes the same full matrix. Reports and screenshots are written beneath `examples/demo-app/.trust/runs/`.

## CLI

```text
trust init [repository]       discover verification and generate trust YAML
trust setup [repository]      bootstrap strict policy and separate expiring keys
trust authority:keygen        generate an Ed25519 authority identity
trust authority:register      register an approver or reporter public key
trust authority:list          inspect fingerprints and key lifecycle state
trust authority:revoke        revoke an identity with an auditable reason
trust ci:init                 generate a fail-closed GitHub Actions workflow
trust policy:digest           print the canonical out-of-band policy trust root
trust schema:export           export JSON Schemas for editor autocomplete
trust contract:init           create an evidence-linked draft contract
trust contract:approve        validate, bind, and sign a contract
trust doctor                  validate policy references and adapter readiness
trust inspect [repository]    print discovery and the configured graph
trust plan <contract>         validate intent and select relevant evidence
trust verify                  execute selected checks, invariants, and QA
trust report <report.json>    render terminal, Markdown, or JSON output
trust report:verify           verify report integrity, policy, and signature
trust report:attest           sign a completed report in a separate trust context
trust audit:append            append a signed report to a hash-chained journal
trust audit:verify            verify journal links, anchors, reports, and trust roots
trust reports:prune           preview or confirm bounded local report retention
trust learn <report.json>     propose reusable verification improvements
trust learn-incident <file>   turn an incident model into proposals
```

`trust plan` and `trust verify` derive changed files from Git by default. Pass `--base <ref>`
to include committed changes since a merge base. `--changed` remains available for isolated fixtures
such as the broken-versus-fixed demo and is recorded as an explicit change-set source in provenance.

## Trust authority semantics

A trusted report must contain at least one verified behavior claim. Each expected behavior has a
stable ID and lists the evidence sources that establish it. Unknown surfaces, missing evidence,
empty plans, cyclic surface dependencies, incomplete approvals, future approval timestamps, and
selected verifiers that produce no result fail closed.

Reports bind the result to the current Git commit and branch, working-tree state, change-set source,
changed-file snapshot digest, policy digest, contract digest, plan digest, runtime, and preview
origin. Explicit file lists are insufficient unless repository policy deliberately enables them for
fixtures. Contract approvals are bound to content and may be signed by Ed25519 identities registered
under `authority.trusted_approvers`. Local approval is rejected unless policy explicitly enables the
fixture escape hatch.

Changed paths are validated before any repository command runs. The authority hashes regular files
and symlink objects without following symlinks outside the repository, records the initial snapshot,
and verifies both that snapshot and Git HEAD remained stable after evidence execution. A check that
rewrites the object under review therefore fails the run even if the check itself exits successfully.

Production policy should also set `require_signed_reports: true` and register CI or remote executor
keys under `authority.trusted_reporters`. Pass `--report-key` and `--report-signer` to `trust verify`,
then use `trust report:verify` to independently validate report content, policy digests, contract
authority, structured verdict, and signature. Private keys under `.trust/keys/` are ignored by Git.

For CI, private keys can be read from a named environment variable with `--key-env` or
`--report-key-env`; the CLI consumes and removes that variable before any repository-owned process
starts. Run `trust ci:init` after registering a reporter to generate an exact-PR-head GitHub workflow,
job summary, annotations, step outputs, cancellation policy, and retained report artifact. See
[GitHub Actions deployment](docs/github-actions.md).

For KMS, HSM, or OIDC brokers, `report:attest --signer-executable <program>` sends a versioned
Ed25519 digest request over standard input and accepts only a JSON signature response. The signer
runs in a fresh temporary working directory with a minimal environment; only variables named by
`--signer-env` cross that boundary. The CLI verifies the returned signature against the registered
reporter before writing anything.

Registered keys may define `not_before` and `not_after`. Revocation records `revoked_at` and a
required reason instead of deleting trust history. Approval and report verification enforce the key
lifecycle at signing time, while current revocation immediately fails verification under the updated
policy digest. `trust doctor` rejects deployments with no active authority and warns before expiry.

Generated policies deny shell-backed checks and full environment inheritance. Repositories that
trust their checked-in command policy may opt into `execution.allow_shell_commands`; structured CLI
and Playwright verifiers receive only a small process environment unless
`execution.inherit_environment` is explicitly enabled. `trust doctor` reports every fixture or
legacy escape hatch as a visible warning.

Versioned JSON Schemas for policy, contracts, plans, reports, external attestation requests, audit
entries, doctor output, and incidents ship in `schemas/` and are generated from the runtime Zod
definitions. `pnpm check` fails on schema drift. Run
`trust schema:export` to copy them into `.trust/schemas` for local editor integration.

Subprocess retries are bounded and backoff-controlled. Every attempt remains evidence, so an earlier
failure cannot be hidden by a later pass. Ctrl-C propagates cancellation and terminates the active
process group. `trust reports:prune` requires `--confirm` and only removes directories containing a
completed `report.json`.

`trust audit:append` stores complete signed reports and their policy digests in a single-writer,
fsynced, hash-chained JSONL journal. It never copies policy adapter values into the journal.
`audit:verify` validates every link, embedded digest, report signature, semantic claim, and the
matching current or explicitly supplied historical policy file. Pin the printed
head digest and record count outside the journal, then pass them back with `--expected-head` and
`--expected-count` to detect replacement or truncation. A local file is tamper-evident, not WORM
storage; production deployments must replicate it to externally governed append-only retention.

Evidence output is redacted before persistence using sensitive environment/configuration values and
common token formats. Request verifiers evaluate bounded response bodies in memory but do not store
them unless `capture_body: true` is explicitly configured. Browser evidence removes URL credentials,
queries, and fragments before recording URLs.

## Production verifier matrix

Repository policy can select six independently evidenced execution surfaces:

- **command checks** integrate typecheckers, linters, tests, security tools, and builds;
- **custom invariants** measure repository-specific budgets against baselines and thresholds;
- **native Playwright** runs existing deterministic browser suites against the supplied preview;
- **request contracts** execute bounded HTTP probes with status, body, and JSON-path assertions;
- **CLI missions** spawn explicit executables without a shell and assert exit/output contracts;
- **browser and device agents** derive journeys from approved intent, run through repository adapters, and capture screenshots, browser errors, response failures, URLs, and visible outcomes.

Every adapter is selected through the same changed-file, surface, dependency, risk, and contract graph. `trust doctor` rejects duplicate evidence IDs, dangling surface dependencies, unknown requirements, missing agent adapters, and missing local Playwright executables before a run starts.

See [the specification](docs/specification.md), [architecture](docs/architecture.md),
[threat model](docs/threat-model.md), and the
[demo contract](examples/demo-app/change-contract.yaml).

## Product boundary

1. **Unfamiliar repository discovery:** useful for package metadata, scripts, languages, common frameworks, CI, docs, ADRs, entry points, routes, and workspaces. It deliberately reports gaps where ownership or thresholds cannot be safely inferred.
2. **Intent without manual command mapping:** the contract names behavior, surfaces, risk, and evidence. Repository policy supplies commands once.
3. **Selective verification:** the graph selects by changed paths, product surface, dependencies, risk tags, and explicit contract evidence; the report preserves selection reasons.
4. **Independent QA:** missions come from intent and risk heuristics, not implementation narration. The demo proves QA catches a behavior ordinary tests miss.
5. **Report as review surface:** terminal, JSON, and PR-ready Markdown expose claims, evidence, unknowns, artifacts, thresholds, and verdict.
6. **Reusable learning:** failures and incidents become proposed knowledge, heuristics, regression tests, or invariants. Nothing is silently promoted.
7. **Hosted boundary:** preview provisioning, parallel/browser compute, persistent organizational knowledge, incident ingestion, cross-repository analysis, integrations, and externally governed WORM retention.
8. **Open/local boundary:** config and contract specifications, discovery, graph semantics, invariant SDK, local runner, basic QA, and reporters.

The local authority does not claim that every routine diff can be ignored. It enforces the narrower
product thesis: where policy, authority, and evidence are complete, the system produces signed,
auditable reasons to trust; where they are incomplete, it says so explicitly and blocks.
