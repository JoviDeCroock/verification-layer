# Architecture

The prototype is a local TypeScript CLI split into focused packages:

- `core`: schemas, evidence semantics, persistence, and orchestration.
- `discovery`: repository inspection and initial configuration generation.
- `contracts`: approval and completeness review.
- `graph`: scope-, dependency-, risk-, and intent-aware verifier selection.
- `runner`: bounded shell adapters for existing tools.
- `invariants`: shell measurements and a TypeScript definition API.
- `qa`: intent-derived missions and isolated Playwright execution.
- `verifiers`: typed browser-agent, device-agent, native Playwright, request, and CLI adapters.
- `reporters`: terminal, JSON, and Markdown evidence views.
- `learning`: approval-required proposals from findings or incidents.
- `cli`: the `trust` commands.

The local boundary owns the inspectable specification, contracts, graph, runner, and basic QA adapters. A future hosted boundary can supply ephemeral compute, preview provisioning, parallel browsers, durable repository knowledge, organization policy, incident integrations, cross-repository impact analysis, and evidence retention without taking ownership of the local policy format.

The adapter boundary is intentionally local and typed. Hosted execution can schedule the same plan remotely, but it must return the same structured evidence states and may not reinterpret `not_verified` as success. Repository adapters remain separate from the coding agent and receive approved intent rather than an implementation narrative.

The demo's Worker uses request-scoped D1 clients, generated binding types, structured logs, awaited promises, and cryptographically random invitation IDs. Its testing-only reset and expired-fixture endpoints illustrate traversal fixtures; a production application would isolate them behind a non-public test binding or environment.
