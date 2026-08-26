# Executable Trust Layer

A local-first merge authority for high-risk and AI-assisted software changes. It reviews approved
intent and concrete evidence instead of trusting implementation narratives or undifferentiated test
output.

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

From an installed source checkout, the zero-setup proof is one command:

```bash
pnpm trust try
```

That shows the bundled broken-versus-fixed proof without configuring a repository. To get a real
local verdict from an existing Git repository, provide the one fact discovery cannot safely infer:

```bash
pnpm trust --intent "Describe the user-visible outcome"
```

After the first public npm release, the checkout and install steps collapse to
`npx executable-trust-layer@latest try` and `npx executable-trust-layer@latest --intent
"Describe the user-visible outcome"`. The package is not currently published; the local tarball is
pack-and-install tested, but this README does not present an unavailable registry command as live.

With no subcommand, the CLI enters the same guided start flow and asks for intent interactively.
It discovers safe structured package scripts, creates a local policy, derives the Git change set,
generates and locally approves a contract, runs the selected evidence, and prints a concise verdict.
No hand-edited YAML, keys, schema export, or shell-command permission is required for the first run.
Generated run artifacts and private keys are ignored through `.trust/.gitignore`; the current
contract remains visible so it can be reviewed and committed for CI.

At any point, `pnpm trust status` summarizes the current state and prints one recommended next
command. It is also the recovery entry point when a later command reports missing setup.

The result explicitly says `LOCAL ASSURANCE`; it is useful repository evidence, not protected merge
authority. Upgrade the same policy and newest generated contract with:

```bash
pnpm trust enable github
```

That creates separate expiring approver and reporter identities, re-signs the contract, writes the
isolated GitHub attestation workflow, and prints the exact secret, policy variable, environment, and
required status check to configure. `trust doctor` reports independent `trial`, `local`, and
`attested` readiness; CI requires `attested`. Guided GitHub enablement currently supports npm and
pnpm projects and fails with a recovery command for other package managers.

From a source checkout, run the live end-to-end demo with:

```bash
pnpm install
pnpm exec playwright install chromium

pnpm demo:prove
```

The proof runs the same approved contract against broken and fixed implementations. Teams that need
manual policy, authority, or attestation control can use the backward-compatible expert commands in
`trust --help --all`; the everyday workflow does not require them. See
[GitHub Actions deployment](docs/github-actions.md) for the protected-CI path.

`demo:prove` runs the same approved contract against two isolated local D1 previews. In the broken variant the static, unit, bundle, native Playwright, request, and CLI evidence passes, but independent browser/device missions discover that retrying and racing the invitation mutation creates duplicate pending invitations. The fixed variant uses a D1 uniqueness invariant and conflict-safe Drizzle insertion, then passes the same full matrix. Reports and screenshots are written beneath `examples/demo-app/.trust/runs/`.

## Everyday CLI

```text
trust --intent "<outcome>"    verify the current change
trust status                  show current state and one recommended next step
trust enable github           add protected CI after a trusted local run
trust try                     show the bundled broken-versus-fixed proof
```

That is the complete everyday command surface. The guided command handles discovery, local policy,
the change contract, evidence selection, execution, and the verdict. Existing low-level commands
remain available for custom policy, authority, attestation, and report automation; run
`trust --help --all` for that expert reference.

## Developer and agent interface

This repository publishes one npm package. The directories under `packages/` are internal source
modules compiled together for the `trust` executable; they are not independently versioned,
published, or supported as package imports. See [the architecture](docs/architecture.md) and
[`packages/README.md`](packages/README.md) for that boundary.

`trust status` is the orientation command for humans, scripts, and coding agents. It reports Git,
policy, contract, last-run, and GitHub-enforcement state, then returns one recommended next action.
Use `trust status --format json` for its versioned machine contract; the matching JSON Schema ships as
`schemas/status.schema.json`. Guided start JSON is similarly defined by `schemas/start.schema.json`.

The guided command and `status` support clean JSON output. Expert `inspect`, `plan`, `verify`, and
`explain` commands do as well. `plan --no-write`
previews evidence selection without changing the repository. `verify --format json` suppresses
GitHub annotations so standard output remains parseable; generated CI uses terminal mode to retain
summaries, outputs, and annotations. See [AGENTS.md](AGENTS.md) for the repository-safe agent loop,
trust boundaries, and exit-code contract. From this source checkout, use `pnpm --silent trust ...`
when parsing JSON so the package-manager script banner is suppressed; an installed `trust` binary
needs no wrapper.

The guided command, `trust plan`, and `trust verify` derive changed files from Git by default. Pass `--base <ref>`
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

Discovered package scripts use structured executable-and-argument checks, so generated policies can
run them without granting shell authority. Generated policies still deny shell-backed checks and
full environment inheritance. Repositories that
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

Known zero-test outputs from test and E2E checks are insufficient evidence even when the underlying
tool exits successfully. A green command that exercised nothing cannot establish user behavior.

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
- **browser and device QA** runs intent-derived journeys through declared repository adapters and captures screenshots, browser errors, response failures, URLs, and visible outcomes.

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

## Mission generation and models

The local trust path does not currently call an LLM. QA missions are derived deterministically from
approved behavior descriptions and declared risks, then executed by a repository-owned adapter.
Every generated mission records the generator name and version plus a digest of its exact inputs;
terminal, JSON, and Markdown reports disclose that provenance and explicitly say when no LLM was
used. QA evidence separately records whether browser execution was deterministic or model-driven;
the bundled demo uses deterministic Playwright journeys. This keeps the default offline,
reproducible, and reviewable.

`contract:init` writes those missions into the draft contract, so approval binds the exact mission
artifact. Verification executes approved `qa_missions` as written and only uses the versioned
deterministic generator as a compatibility fallback for older contracts.

A model could improve mission proposals before approval, but it must not become an invisible trust
root. Any model-backed generator must record its provider, exact model, prompt digest, and input
digest, return schema-validated missions, and have its output bound into the approved artifact before
verification. `pnpm eval:missions` runs the checked-in intent corpus against the deterministic
control; the same fail-closed scorer accepts repeated model candidates and records coverage,
hallucinations, stability, latency, token use, and explicit human labels. The current comparison did
not establish executable value: repository adapters dispatch by approved mission identity, so
model-written titles and objectives do not alter browser actions. Accordingly, the product selects
no proposal model. A checked-in policy can only select one after automated, operational,
defect-yield, and complete human-review gates pass. `pnpm eval:missions:review` exports blinded,
digest-bound review packets for a real executed pilot and applies completed labels without mutating
the raw model artifact; verification itself remains deterministic. See
[mission generation](docs/mission-generation.md) and the
[Terra/Sol/Luna benchmark](docs/mission-generation-benchmark-2026-08-25.md).

## Contributing and releases

Executable Trust Layer is available under the [Apache License 2.0](LICENSE). See
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and Changeset policy, and
[the release guide](docs/releases.md) for version pull requests, package validation, and the
maintainer-controlled publishing boundary. The release-preparation workflow never publishes to npm.

Please report vulnerabilities through the private process in [SECURITY.md](SECURITY.md), not a
public issue.
