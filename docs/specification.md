# Local trust specification

## Evidence states

Every verifier emits exactly one of four states:

- `verified`: the selected verifier ran and established its claim.
- `failed`: the verifier ran and contradicted the claim or breached a threshold.
- `not_applicable`: policy explicitly determines that the evidence does not apply.
- `not_verified`: the evidence is required or relevant, but no trustworthy result exists.

Unknowns never become success. A `failed` item rejects the change. A `not_verified` item yields insufficient evidence.

## Trust configuration

`trust.yaml` is versioned repository policy. It names knowledge sources, commands, custom invariants, product surfaces, dependencies between surfaces, and QA traversal instructions. Commands remain adapters to existing tools; they do not replace linters, test frameworks, or benchmark suites.

## Change contract

The change contract is the human review surface. It contains intent, expected behavior, affected surfaces, risks, explicit evidence, exclusions, and approval metadata. Verification refuses to treat a draft contract as approved evidence.

## Selection graph

The planner combines changed files, surface paths and dependencies, check scopes, invariant scopes, check risk tags, and the contract's explicit evidence. The report records every selection reason so a reviewer can audit why a verifier did or did not run.

## Verifier adapters

`verifiers` is a discriminated configuration list. Supported production-shaped adapter kinds are:

- `playwright`: explicit executable/arguments, preview URL injected through `TRUST_PREVIEW_URL`, and exit/output expectations.
- `requests`: bounded response capture with status, body substring, and JSON-path equality expectations. Headers are never copied into evidence.
- `cli`: one or more no-shell process missions with explicit executable, arguments, optional stdin, bounded output, timeout, and exit/output expectations.
- `agent-browser`: intent-derived desktop missions executed by a repository-owned traversal adapter.
- `agent-device`: the same independent mission source repeated under declared viewport, touch, and optional user-agent profiles.

Evidence IDs are unique across checks, invariants, and verifiers. Surface requirements and surface dependencies must resolve when configuration is loaded; invalid graphs fail before execution.

## QA isolation

Mission generation consumes the approved contract, repository instructions, and durable risk heuristics. It never consumes the implementation agent's explanation. A repository adapter translates generic mission IDs into safe product traversal. The runner independently captures status, final URL, browser errors, request failures, and screenshots.

Expected negative-path statuses must be declared by the adapter. They remain recorded in measurements but do not become false infrastructure failures. Unexpected HTTP errors, console errors, uncaught exceptions, and transport failures fail the mission.

## Execution safety

Structured CLI and Playwright adapters do not use a shell. Legacy command checks are an explicit trusted-repository shell adapter for compatibility with existing CI scripts. Subprocess output is bounded, timeouts terminate the spawned process group, and non-terminating children are force-killed. HTTP bodies are streamed only up to the evidence capture limit. Configured headers and environment mappings are not written to reports.

## Learning

Verification findings and incidents produce a proposal document with `approval.status: proposed`. The CLI does not edit repository policy, tests, or knowledge automatically.
