# Change verification

## Intent

Add organization invitations without weakening authorization or existing signup behavior.

## Plan

- ✅ approved

## Implementation

- 2 changed file(s)
- Commit: `022f1d6fb1690a4a5e9a64f7bff06c314edc74f9`
- Branch: `detached or unavailable`
- Working tree: dirty
- Change-set source: explicit
- Contract digest: `1322216099c82749f025a19b68b8c4e5f4fb1e11c363a520ae9ece1b5dc867ef`
- Policy digest: `ff15f041adf93510255c318cc1d0eafd56ddac0684dc9f0848d576ca14e91fb6`
- Plan digest: `42da0dcd282ddc1d4845d915dce747896342f1a07a1c6a0a44c9d4b1b6ecf266`
- Change-set digest: `bf906672942deba40b15d2e4f1c7cb46cd4839af28d645f163cf0e35566bc9d4`
- Attestation: none
- Assurance: trial
- Preview origin: http://127.0.0.1:44317

## Behavior claims

- ✓ **happy-path** — Expected behavior verified: admins can invite users by email
- ✓ **authorization** — Expected behavior verified: non-admins cannot invite users
- ✗ **duplicate-submission** — Expected behavior was not established: duplicate invitations do not create duplicate pending invitations
- ✓ **expiration** — Expected behavior verified: invitations expire after seven days
- ✓ **regression** — Expected behavior verified: existing signup behavior remains unchanged

## Verification

- ✓ **change-contract-approval** — Change contract was approved by demo-product-owner before verification.
- ✓ **change-set-authority** — Repository policy allows an explicit fixture change set.
- ✓ **change-set-presence** — The change set contains 2 canonical repository-relative path(s).
- – **report-attestation** — Repository policy does not require report attestation.
- ✓ **contract-policy** — Change contract is complete and resolves against repository policy.
- ✓ **client-build** — Preact client build passed.
- ✓ **typecheck** — TypeScript passed.
- ✓ **unit-tests** — Unit tests passed.
- ✓ **demo-client-bundle** — Preact client bundle: 36304 bytes within threshold on attempt 1.
- ✓ **api-requests:health** — GET /api/health satisfied its response contract.
- ✓ **api-requests:unauthorized-invitation** — POST /api/invitations satisfied its response contract.
- ✓ **agent-browser:intent-browser:happy-path** — An administrator invited a new user through the running UI.
- ✓ **agent-browser:intent-browser:authorization** — A non-admin was denied and no invitation was created.
- ✗ **agent-browser:intent-browser:duplicate-submission** — Duplicate submission counts were sequential=2, concurrent=2.
- ✓ **agent-browser:intent-browser:expiration** — An expired invitation was rejected in the acceptance journey.
- ✓ **agent-browser:intent-browser:regression** — The existing signup surface remained reachable and interactive.
- ✓ **agent-device:intent-device:mobile-390x844:happy-path** — An administrator invited a new user through the running UI.
- ✓ **agent-device:intent-device:mobile-390x844:authorization** — A non-admin was denied and no invitation was created.
- ✗ **agent-device:intent-device:mobile-390x844:duplicate-submission** — Duplicate submission counts were sequential=2, concurrent=2.
- ✓ **agent-device:intent-device:mobile-390x844:expiration** — An expired invitation was rejected in the acceptance journey.
- ✓ **agent-device:intent-device:mobile-390x844:regression** — The existing signup surface remained reachable and interactive.
- ✓ **agent-device:intent-device:mobile-390x844:mobile-journey** — An administrator invited a new user through the running UI.
- ✓ **playwright-ui** — Native Playwright suite passed.
- ✓ **trust-cli:version** — CLI mission version passed.
- ✓ **trust-cli:selective-plan** — CLI mission selective-plan passed.
- ✓ **change-set-stability** — Changed-file contents remained stable throughout evidence execution.
- ✓ **repository-head-stability** — Git HEAD remained stable throughout evidence execution.

## QA mission generation

- Deterministic: executable-trust-layer/intent-heuristics@1; no LLM used; 6 mission(s)
- **happy-path** — admins can invite users by email; derived from `admins can invite users by email`; input `d2e427004b85`
- **authorization** — Unauthorized actor is denied; derived from `non-admins cannot invite users`; input `64954a5a2284`
- **duplicate-submission** — Retry and duplicate submission; derived from `duplicate invitations do not create duplicate pending invitations`; input `58da06fbc16b`
- **expiration** — Expired artifact is rejected; derived from `invitations expire after seven days`; input `9a89ab7ebc1e`
- **regression** — Existing adjacent journey remains intact; derived from `existing signup behavior remains unchanged`; input `a786b57d0f96`
- **mobile-journey** — Primary journey works on a mobile viewport; derived from `risk heuristic: mobile`; input `bb7ad28ac0f4`

## QA execution

- Deterministic: trust-demo/playwright-journeys@1; no LLM used

## Evidence selection

- **surface:team-management**: changed files matched src/worker.ts, src/client.tsx, src/domain.ts, src/schema.ts
- **surface:authentication**: changed files matched src/domain.ts, src/client.tsx; dependency of surface team-management
- **typecheck**: required by surface team-management; required by surface authentication; changed files matched check scope; selected for contract risk authorization; explicitly required by approved contract
- **unit-tests**: required by surface team-management; required by surface authentication; selected for contract risk authorization; explicitly required by approved contract
- **client-build**: required by surface team-management; changed files matched check scope
- **demo-client-bundle**: required by surface team-management; changed files matched invariant scope; explicitly required by approved contract
- **playwright-ui**: required by surface team-management; required by surface authentication; changed files matched verifier scope; selected for contract risk mobile ui; explicitly required by approved contract
- **api-requests**: required by surface team-management; required by surface authentication; changed files matched verifier scope; selected for contract risk authorization; explicitly required by approved contract
- **trust-cli**: required by surface team-management; explicitly required by approved contract
- **intent-browser**: required by surface team-management; required by surface authentication; changed files matched verifier scope; selected for contract risk authorization; explicitly required by approved contract
- **intent-device**: required by surface team-management; required by surface authentication; changed files matched verifier scope; selected for contract risk mobile ui; explicitly required by approved contract

## Unverified assumptions

- ⚠️ production email delivery was not verified: The demo has no external email provider.

## Learning proposals

- **qa-heuristic**: Retain the scenario “Duplicate submission counts were sequential=2, concurrent=2.” in future intent-derived QA missions.
- **regression-test**: Add a deterministic regression test covering: Duplicate submission counts were sequential=2, concurrent=2.
- **regression-test**: Preserve the failure detected by claim:duplicate-submission as a focused regression test.
- **knowledge**: Document how to verify: production email delivery was not verified: The demo has no external email provider.

## Verdict

❌ **Change does not satisfy approved intent.**
