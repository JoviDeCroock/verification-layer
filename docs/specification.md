# Local trust specification

## Evidence states

Every verifier emits exactly one of four states:

- `verified`: the selected verifier ran and established its claim.
- `failed`: the verifier ran and contradicted the claim or breached a threshold.
- `not_applicable`: policy explicitly determines that the evidence does not apply.
- `not_verified`: the evidence is required or relevant, but no trustworthy result exists.

Unknowns never become success. A `failed` item rejects the change. A `not_verified` item yields insufficient evidence.
Test and E2E checks that exit successfully while reporting zero executed tests are `not_verified`,
not passes; an empty suite cannot establish an approved behavior.

## Assurance levels

Verdict and assurance answer different questions. The verdict says what the evidence established;
assurance says how strongly the run identity is protected:

- `trial`: an explicit fixture change set or bundled proof;
- `local`: a Git-derived repository snapshot without protected report attestation; and
- `attested`: a Git-derived snapshot with a currently trusted Ed25519 reporter signature.

Historical reports without an assurance field remain readable; readers derive the level from
change-set provenance and attestation. `trust doctor --require trial|local|attested` checks readiness
for the requested use instead of treating unfinished production deployment as a failed first run.

## Experience contracts

The terminal interface leads with `try`, `status`, `start`, `explain`, and `enable github`; expert
policy and authority commands remain grouped in help instead of defining the first-run path.
`trust status` emits a versioned repository-state document and exactly one recommended next action.
Its JSON Schema is distributed with the other public contracts.

`start`, `status`, `inspect`, `plan`, `verify`, and `explain` accept `--format json`. JSON mode writes
only the requested document to standard output. Guided start has a versioned result schema for both
completed verification and the non-error `no_changes` state. `plan --no-write` is the non-mutating
selection preview.
Exit code `0` means command success or a trusted verification verdict, `1` means a runtime/readiness
failure or non-trusted verdict, and `2` means contract review prevented planning.

## Trust configuration

`trust.yaml` is versioned repository policy. It names knowledge sources, commands, custom invariants, product surfaces, dependencies between surfaces, and QA traversal instructions. Commands remain adapters to existing tools; they do not replace linters, test frameworks, or benchmark suites. Discovered package scripts are represented as structured `executable`, `args`, `cwd`, and `env` values. Legacy shell strings remain supported only behind the explicit shell-command policy exception.

## Change contract

The change contract is the human review surface. It contains intent, expected behavior, affected surfaces, risks, explicit evidence, exclusions, and approval metadata. Verification refuses to treat a draft contract as approved evidence.

Every expected behavior has a stable kebab-case ID, a human-readable description, and one or more
configured evidence source IDs. All of those sources must also appear in `required_evidence`.
References may select a specific structured result with `source#result`, for example
`api-contracts#unauthorized-user`; this prevents an unrelated result from the same verifier from
establishing or failing the claim.
Contracts with unknown surfaces, uncovered behaviors, missing evidence, incomplete approval
metadata, approval timestamps later than verification, or content changed after approval are invalid.
`contract:approve` records a canonical SHA-256 digest of the approved contract content so subsequent
edits invalidate approval.

## Authority and signatures

Production approval uses Ed25519. Repository policy registers one-line SPKI public keys under
`authority.trusted_approvers`; the contract records the signer ID and a signature binding approver,
approval time, key ID, and approved-content digest. Local assertions fail unless
`allow_local_approvals` is explicitly enabled for a fixture.

When `require_signed_reports` is enabled (the generated-policy default), verification is insufficient
without a private key matching a registered `trusted_reporters` identity. The final report signature
binds the complete report, including evidence, verdict, provenance, and learning proposals.
`report:verify` validates the signature, current policy digest, embedded contract and plan digests,
contract authority, plan selection, selected-source coverage, every behavior claim, and verdict
recomputation without rerunning evidence. `report:attest` performs the same semantic validation before
signing. Reports are written atomically and `report.json` is published last as the completed-run
marker.

Key generation writes an Ed25519 PKCS#8 private key with owner-only permissions and a one-line SPKI
public key. `authority:register` adds the public key to approver or reporter policy. A report may be
signed during `verify`, or passed to `report:attest` when evidence execution and key custody belong to
separate processes.

An external signer is an explicit executable adapter. It receives one strict JSON object on standard
input containing `version`, `algorithm`, `signer_id`, `signed_at`, `report_sha256`, and the
domain-separated `signing_digest`; it returns `{ "signature": "<base64>" }`. The authority gives the
adapter a temporary working directory and minimal process environment plus only variables explicitly
selected with `--signer-env`. Non-zero exit, timeout, malformed JSON, or a signature that does not
verify against the registered reporter public key fails before report persistence.

Trusted keys may have activation and expiry timestamps. Revocation is retained in policy with a
timestamp and mandatory reason; it is never represented by silently deleting the public key.
Signatures outside the activation window fail, and a currently revoked key invalidates approval or
report verification. Key IDs are unique per role, so rotation registers a new identity before the old
identity is revoked.

## Selection graph

The planner combines changed files, surface paths and dependencies, check scopes, invariant scopes, check risk tags, and the contract's explicit evidence. The report records every selection reason so a reviewer can audit why a verifier did or did not run.

Surface dependencies are closed transitively and cycles are invalid. Risk tags are normalized across
spaces, punctuation, and kebab-case before matching. A plan with no executable evidence is
insufficient; approval alone can never produce a trusted verdict.

## Claims and provenance

Verification aggregates structured evidence by source and emits a claim result for every expected
behavior. A claim is verified only when every named evidence source produces results and all of
those results are verified. Missing or inconclusive sources make the claim `not_verified`; any failed
source fails the claim.

Every report records the Git head and branch, dirty state, base commit when supplied, change-set
source, SHA-256 digests of policy, contract, plan, and changed-file contents, runtime versions, and
the preview origin. Explicit file lists are rejected unless repository policy enables the fixture-only
escape hatch. This
prevents accidental ambiguity about what a report describes. The same specification supports local
Ed25519 authority and remotely held organizational keys.

Changed paths must be canonical repository-relative paths and are validated before evidence starts.
Regular file contents and symlink targets are distinct snapshot object types; hashing never follows a
symlink to read content outside the repository. The initial changed-file digest and Git HEAD are
captured before execution and compared again afterward. Either moving during the run is failed plan
evidence, and the report remains bound to the initial snapshot.

## Verifier adapters

`verifiers` is a discriminated configuration list. Supported production-shaped adapter kinds are:

- `playwright`: explicit executable/arguments, preview URL injected through `TRUST_PREVIEW_URL`, and exit/output expectations.
- `requests`: bounded response capture with status, body substring, and JSON-path equality expectations. Headers are never copied into evidence.
- `cli`: one or more no-shell process missions with explicit executable, arguments, optional stdin, bounded output, timeout, and exit/output expectations.
- `agent-browser`: intent-derived desktop missions executed by a repository-owned traversal adapter.
- `agent-device`: the same independent mission source repeated under declared viewport, touch, and optional user-agent profiles.

Evidence IDs are unique across checks, invariants, and verifiers. Surface requirements and surface dependencies must resolve when configuration is loaded; invalid graphs fail before execution.

## QA isolation

Mission generation consumes approved behavior descriptions and declared risks. It never consumes the
implementation agent's explanation. The built-in generator is deterministic and records its name,
version, and exact input digest on every mission; reports explicitly disclose that no LLM was used.
A repository adapter translates generic mission IDs into safe product traversal. The runner
independently captures status, final URL, browser errors, request failures, and screenshots.
Repository policy declares whether traversal is deterministic or model-driven. QA evidence records
the policy-bound adapter name and version and, for model-driven traversal, its provider, exact model,
and prompt digest. Missing executor provenance produces `not_verified` evidence rather than silently
being treated as deterministic execution.

Model-assisted mission proposals belong before contract approval. A model-backed generator must
record provider, exact model, prompt digest, and input digest, and its schema-validated output must be
bound into the approved artifact before it can influence a trusted verification plan. Verification
must not make an unrecorded or mutable model call.

`contract:init` binds built-in deterministic missions into `qa_missions` on the draft. When an
approved contract contains `qa_missions`, verification executes that exact artifact and does not add
runtime heuristics. Contracts created before mission binding remain compatible and visibly use the
versioned deterministic fallback generator.

Expected negative-path statuses must be declared by the adapter. They remain recorded in measurements but do not become false infrastructure failures. Unexpected HTTP errors, console errors, uncaught exceptions, and transport failures fail the mission.

## Execution safety

Structured CLI and Playwright adapters do not use a shell. Legacy command checks are an explicit trusted-repository shell adapter for compatibility with existing CI scripts. Subprocess output is bounded, timeouts terminate the spawned process group, and non-terminating children are force-killed. HTTP bodies are streamed only up to the evidence capture limit. Configured headers and environment mappings are not written to reports.

Generated policy disables shell-backed checks and invariant commands. Enabling them is an explicit
repository trust decision surfaced by `doctor`. Structured child processes inherit only a minimal
operating-system environment by default; full inheritance is a separate opt-in.

`execution.max_attempts` is bounded to five and `retry_backoff_ms` to 30 seconds. Attempts are
separate results under the same evidence source, so any failed attempt keeps its behavior claim
unverified. Cancellation propagates to active process groups. Local retention is an explicit
preview-then-confirm operation and ignores directories without a completed report marker.

The local audit journal is JSONL with one complete signed report and governing policy digest per
record; it deliberately does not duplicate policy adapter values into the journal.
Records have monotonic sequence numbers and link to the SHA-256 digest of their predecessor. Writers
use an exclusive lock, reject symlinks and invalid existing chains, append one record, and fsync it.
Duplicate reports and stale expected heads or counts are rejected. Verification requires an accepted
policy file for every record and independently checks its digest, report authority, and semantics. The caller
must preserve a head digest and count outside the journal to make truncation or replacement
detectable; filesystem chaining alone is not an append-only storage guarantee.

Before persistence, evidence summaries, commands, output, errors, and string measurements are
redacted using configured credentials, sensitive process environment values, private-key blocks, and
common provider token formats. HTTP response bodies are used for assertions but omitted from evidence
unless `capture_body` is explicitly enabled. Browser URLs are reduced to origin and pathname.

## Learning

Verification findings and incidents produce a proposal document with `approval.status: proposed`. The CLI does not edit repository policy, tests, or knowledge automatically.
