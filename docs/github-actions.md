# GitHub Actions deployment

Generate the workflow only after the approved contract and trusted reporter public key are present:

```sh
trust ci:init \
  --config trust.yaml \
  --contract change-contract.yaml \
  --report-signer ci \
  --authority-package @your-org/executable-trust@1.0.0
```

The command refuses to overwrite an existing workflow, rejects unsafe workflow values, validates the
contract, and requires `ci` under `authority.trusted_reporters`. Add the matching private key as the
`TRUST_REPORT_PRIVATE_KEY` Actions secret, set repository variable `TRUST_POLICY_SHA256` to the digest
printed by `ci:init` or `trust policy:digest`, and protect the `trust-authority` environment. The generated base-branch
workflow:

- checks out the pull request head SHA rather than GitHub's synthetic merge ref;
- fetches history so the planner can derive the base-to-head change set;
- runs `doctor` before executing repository evidence;
- runs repository evidence in a job that has no reporter secret and does not persist Git credentials;
- transfers the unsigned report to a fresh, protected attestation job;
- installs an exact authority package and pins every third-party action to an immutable commit;
- checks the candidate as data in the attestation job but never executes candidate code there;
- requires the out-of-band policy digest before the reporter key can sign;
- reads the reporter key only in the isolated job and consumes it before Git subprocesses start;
- writes a bounded job summary, escaped claim annotations, and step outputs;
- uploads the complete report directory even when verification fails;
- cancels superseded executions and applies a job timeout; and
- fails closed when the key, approval, evidence, provenance, or attestation is unavailable.

The required authority package spec must be an exact semantic version. It is embedded unchanged and
installed globally from npm after candidate dependencies; use an approved public release that needs
no secret on the evidence runner. The candidate dependency installation supports pnpm and npm:

```sh
trust ci:init --package-manager pnpm
trust ci:init --package-manager npm
```

## Isolation model

The workflow uses `pull_request_target` so GitHub loads the workflow definition from the protected
base branch, not from the pull request. This is safe only because untrusted candidate commands run in
the secretless `evidence` job. The `attest` job is a fresh runner: it downloads the report, checks out
the exact candidate SHA in a separate path, validates the current files and policy digest, and signs
without installing dependencies or executing candidate scripts. Never combine these jobs or add
candidate execution to `attest`.

For fork pull requests, protect the `trust-authority` environment with required reviewers and an
appropriate deployment-branch policy. A hosted signer can replace the environment secret with OIDC
authentication while returning the same Ed25519 report format. Replace the key flags in the
attestation step with `--signer-executable`, repeat `--signer-arg` for an approved broker command,
and name only the broker's short-lived credential variables with `--signer-env`. The broker receives
the versioned request documented in the specification; the CLI still validates the reporter key,
policy, semantics, and returned signature.

## Merge protection

After a successful run, require the `attest` job as a branch-protection check. The CLI writes these
step outputs for downstream automation:

```text
trust_verdict
trust_run_id
trust_report
trust_head_sha
```

The report artifact is useful for review and debugging, but merge automation should trust the job
exit status and independently verifiable signed report—not a mutable summary string.

Before discarding the runner, append the signed report to an organization-owned audit journal and
store the printed head digest plus record count in an independent checkpoint system. The bundled
`audit:append`/`audit:verify` commands provide chain and report verification; GitHub artifacts alone
are retention copies, not append-only transparency storage.

## Rotation and revocation

Register a replacement reporter with a distinct ID, update the workflow and secret, verify a signed
run, and only then revoke the previous identity:

```sh
trust authority:register .trust/keys/ci-2027.public.txt \
  --config trust.yaml --id ci-2027 --role reporter --not-after 2028-01-01T00:00:00Z
trust ci:init .github/workflows/trust-2027.yml --report-signer ci-2027 \
  --authority-package @your-org/executable-trust@1.0.0
trust authority:revoke ci-2026 --config trust.yaml --role reporter \
  --reason "scheduled annual rotation"
```

`trust authority:list` prints the role, stable ID, public-key fingerprint, and current lifecycle
state. Revocation changes the policy digest and intentionally causes reports under the previous
policy to fail current-policy verification.
