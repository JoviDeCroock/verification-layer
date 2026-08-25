# Executable Trust agent guide

Use the trust interface as the source of truth for change verification. Start every unfamiliar task
with:

```sh
pnpm --silent trust status --format json
pnpm --silent trust inspect --format json
```

The status response is versioned and names one recommended next action. Its JSON Schema is
`schemas/status.schema.json`. Discovery includes the proposed policy, while `inspect --config
trust.yaml --format json` also includes the configured verification graph.

For first-run automation, pass the intent explicitly and request the versioned start result:

```sh
pnpm --silent trust start --intent "Describe the user-visible outcome" --format json
```

The response is either `completed` with the full trust report or `no_changes` with a recovery action;
its schema is `schemas/start.schema.json`.

For a changed repository, preview selection without writing artifacts:

```sh
pnpm --silent trust plan .trust/contracts/current.yaml \
  --config trust.yaml --format json --no-write
```

Run evidence with machine-readable output using:

```sh
pnpm --silent trust verify --config trust.yaml \
  --contract .trust/contracts/current.yaml \
  --format json --no-ci-output
```

Interpret `trusted`, `not_trusted`, and `insufficient_evidence` literally. Never turn missing or
`not_verified` evidence into success. Use `trust explain <evidence> --format json` before changing
policy or code in response to a blocker.

Safety constraints:

- Derive changed files from Git unless a checked-in fixture explicitly authorizes `--changed`.
- Do not enable shell commands or full environment inheritance to make onboarding pass.
- Do not read, print, commit, or pass `.trust/keys/*.private.pem` to repository-owned commands.
- Do not edit generated files under `.trust/runs/`; rerun verification instead.
- Do not weaken local or attested authority policy to convert a failing verdict into success.
- Run `pnpm check` after code, schema, or policy-interface changes.

CLI exit conventions are: `0` for a successful command or trusted verdict, `1` for runtime errors,
failed readiness, or an untrusted/insufficient verdict, and `2` for an invalid change contract during
planning.
