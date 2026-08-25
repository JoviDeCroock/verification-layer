# Threat model

## Security objective

The trust authority answers one narrow question: did the exact candidate snapshot establish every
approved behavior under the expected repository policy, through the selected evidence graph, and did
a currently trusted reporter attest that result? It must fail closed when any part of that statement
cannot be established.

## Trust roots

A production deployment has four explicit trust roots:

1. the out-of-band canonical policy digest;
2. approver public keys and their activation, expiry, and revocation state;
3. reporter public keys and their lifecycle state; and
4. the protected base-branch CI workflow plus exact authority package version.

The change contract, report, candidate checkout, repository checks, QA adapters, and uploaded
artifacts are inputs—not trust roots.

## Attacker capabilities

Assume a candidate change can modify application code, tests, scripts, package manifests, lockfiles,
QA adapters, workflow files in the candidate branch, process output, HTTP responses, symlinks, and
untracked files. It may hang, spawn descendants, rewrite reviewed files, emit control sequences,
include secrets in output, or attempt to read inherited environment variables.

Assume an attacker may also tamper with an unsigned report or replay an older report. Do not assume a
repository subprocess, browser adapter, or implementation-agent narrative is honest merely because
it exits successfully.

## Enforced boundaries

- Intent approval and report attestation use separate Ed25519 roles.
- Signatures bind canonical content and timestamps; current policy enforces lifecycle and revocation.
- CI evidence runs without reporter authority. The reporter key exists only on a fresh protected job
  that does not execute candidate code.
- The attester requires an out-of-band policy digest, exact Git HEAD, initial changed-file digest, and
  a semantically recomputed plan, evidence coverage, claims, and verdict.
- Canonical changed paths cannot escape the repository. Symlink objects are hashed without following
  external targets.
- Git HEAD and changed contents must remain stable across evidence execution.
- Structured adapters avoid a shell; legacy shell execution and full environment inheritance are
  explicit policy exceptions surfaced by `doctor`.
- Process output and HTTP bodies are bounded. Active process groups receive cancellation and timeout
  termination. Retried failures remain failed evidence.
- Sensitive values and common credential formats are redacted before atomic report persistence.
- External signers receive only a digest request, a temporary working directory, a minimal
  environment, and explicitly selected credential variables; returned signatures are verified
  locally before persistence.
- Local audit records are serialized, fsynced, hash-chained, and verifiable against externally held
  head/count checkpoints and accepted policy digests.
- GitHub workflow values and annotations are escaped, external actions are commit-pinned, checkout
  credentials are not persisted, and superseded runs are cancelled.

## Deliberate non-guarantees

The local authority does not prove that a repository-authored test or QA adapter is itself correct.
Changes to verification sources therefore need SCM ownership rules, independent review, and an
appropriate protected surface in repository policy. It does not itself provide HSM/KMS custody,
externally governed WORM storage, trusted timestamping, malware isolation stronger than the CI
runner, or a hosted revocation/control plane. It provides a generic signer protocol and
tamper-evident local journal that those systems can consume.

It also does not infer that an exclusion is safe. Exclusions are preserved as unknowns and cannot
become verified claims.

## Production deployment requirements

- Protect the base workflow, trust policy, contract-approval paths, and verification adapters with
  CODEOWNERS or equivalent mandatory review.
- Protect the `trust-authority` environment and restrict who can approve its use.
- Connect `--signer-executable` to an organization-owned KMS/HSM or OIDC broker, or use a protected
  CI secret as the transitional custody mechanism.
- Set and independently control `TRUST_POLICY_SHA256`; update it only through an audited policy-change
  procedure.
- Pin the authority package and every external action; use a lockfile for candidate dependencies.
- Require the isolated attestation job as the merge check, append signed reports to the audit
  journal, anchor its head/count externally, and retain the journal in governed WORM storage.
- Rotate keys before expiry, revoke suspected keys immediately, and preserve the reason in policy.
- Monitor rejected, cancelled, missing-evidence, policy-mismatch, and revocation events.

## Residual work

The hosted production boundary should add provider-specific OIDC/KMS integrations,
organization RBAC, append-only audit/transparency storage, trusted timestamps, policy-change approval,
SCM status publication, preview orchestration, quotas, and operational SLOs. Those services must
consume and emit the same fail-closed local schemas; they may not reinterpret `not_verified` as
success.
