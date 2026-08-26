# Architecture

The product is a local-first TypeScript trust authority organized into focused internal modules:

- `core`: schemas, evidence semantics, persistence, and orchestration.
- `core/provenance`: canonical policy, contract, and plan digests plus Git/runtime identity.
- `core/attestations`: Ed25519 identities, contract signatures, and report attestations.
- `core/audit`: serialized, fsynced, hash-chained signed-report journaling and verification.
- `core/redaction`: evidence sanitization before reports or learning proposals are persisted.
- `core/report-validation`: independent plan, evidence coverage, claim, and verdict recomputation.
- `discovery`: repository inspection and initial configuration generation.
- `contracts`: approval and completeness review.
- `graph`: scope-, dependency-, risk-, and intent-aware verifier selection.
- `runner`: isolated, bounded, cancellable execution with auditable retries and legacy shell adapters.
- `invariants`: shell measurements and a TypeScript definition API.
- `qa`: intent-derived missions and isolated Playwright execution.
- `verifiers`: typed browser-agent, device-agent, native Playwright, request, and CLI adapters.
- `reporters`: terminal, JSON, and Markdown evidence views.
- `learning`: approval-required proposals from findings or incidents.
- `cli`: the `trust` commands.
- `cli/ci`: escaped GitHub summaries, outputs, annotations, and strict workflow generation.
- `schemas`: distributable editor contracts generated and drift-checked from the runtime schemas.

These modules compile and ship together as the single `executable-trust-layer` npm package. They do
not have independent manifests, versions, dependency declarations, or release lifecycles; the root
`package.json` owns that metadata and exposes the installed `trust` executable. The `packages/`
directory is a source-code boundary, not a pnpm workspace or a collection of public package APIs.

The onboarding surface composes those modules without weakening them. `trust --intent` performs
discovery, writes a local-only policy, derives the Git change set, creates and locally approves the
bound contract, invokes the normal verifier, and renders the same report schema used by expert-mode
commands. `trust enable github` upgrades authority and workflow files rather than maintaining a
separate simplified verification engine.

The local boundary owns the inspectable specification, contracts, Ed25519 authority, external signer protocol, report attestation, tamper-evident audit journal, graph, runner, provenance capture, and basic QA adapters. A hosted boundary can supply provider-specific key custody, externally governed WORM retention, ephemeral compute, preview provisioning, parallel browsers, durable repository knowledge, organization policy, incident integrations, and cross-repository impact analysis without taking ownership of the local policy format.

The adapter boundary is intentionally local and typed. Hosted execution can schedule the same plan remotely, but it must return the same structured evidence states and may not reinterpret `not_verified` as success. Repository adapters remain separate from the coding agent and receive approved intent rather than an implementation narrative.

Report views are replaced atomically, with `report.json` published last as the completed-run marker.
An attestation context recomputes plan selection, evidence coverage, claims, and verdict before signing;
a cryptographically valid signature cannot make a semantically inconsistent report acceptable.

The demo's Worker uses request-scoped D1 clients, generated binding types, structured logs, awaited promises, and cryptographically random invitation IDs. Its testing-only reset and expired-fixture endpoints illustrate traversal fixtures; a production application would isolate them behind a non-public test binding or environment.
