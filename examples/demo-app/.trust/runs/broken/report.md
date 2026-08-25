# Change verification

## Intent

Add organization invitations without weakening authorization or existing signup behavior.

## Plan

- ✅ approved

## Implementation

- 2 changed file(s)
- Commit: `25080f6f14952e5c8312767fc36952ee3474a4f3`
- Branch: `main`
- Working tree: dirty
- Change-set source: explicit
- Contract digest: `a78dd4d5ad86f919ffd665ecd61bb8571816dca2ef59b081801cbb6eebccd91e`
- Policy digest: `ce3d412a65f1c7b780116358b50ee63ab1cd0f3c73622cef9f5942bb0547683a`
- Plan digest: `e0c7d95631915295874a3a38d9ee6b30e0573f19c85b0e0f92d22c8916dcd5ca`
- Change-set digest: `bf906672942deba40b15d2e4f1c7cb46cd4839af28d645f163cf0e35566bc9d4`
- Attestation: none
- Preview origin: http://127.0.0.1:4317

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
