# Contributing

Thank you for helping improve Executable Trust Layer. Changes should preserve its fail-closed trust
boundary: missing, stale, empty, or unverifiable evidence must never become a successful verdict.

## Development

This repository requires Node.js 22 and pnpm 11.3.0.

```sh
pnpm install
pnpm check
```

Run the deterministic bundled proof with `pnpm --silent trust try`. Changes that affect the full
verification matrix should also run `pnpm demo:prove`; it exercises local D1 previews and browser
tooling, so install Chromium first with `pnpm exec playwright install chromium`.

## Pull requests

- Keep changes focused and explain the user-visible outcome.
- Add or update direct regression coverage.
- Regenerate versioned schemas when a public Zod contract changes.
- Do not commit generated `.trust/runs/` output or private authority keys.
- Do not weaken policy, evidence, or authority requirements to make a check pass.
- Run `pnpm check` before requesting review.

## Changesets

Add a Changeset for every user-visible change to the published package:

```sh
pnpm changeset
```

Select `executable-trust-layer`, choose the semantic-version impact, and describe the outcome for
users. A good entry explains behavior rather than implementation mechanics. Documentation-only,
test-only, and internal release-infrastructure changes do not require a Changeset.

After a Changeset reaches `main`, the release-preparation workflow creates or updates a version pull
request. It does not publish. See [docs/releases.md](docs/releases.md) for the complete maintainer
flow.

## License

Unless explicitly stated otherwise, contributions intentionally submitted to this repository are
licensed under the [Apache License 2.0](LICENSE).
