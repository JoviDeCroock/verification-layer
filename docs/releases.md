# Releases

Executable Trust Layer uses Changesets for semantic versions and changelog entries. The setup follows
Pracht's GitHub API commit mode while keeping npm publication under explicit maintainer control.

## Contributor flow

Every user-visible package change should include one `.changeset/*.md` file:

```sh
pnpm changeset
```

Choose `executable-trust-layer`, select `patch`, `minor`, or `major`, and write a concise outcome for
users. Adjacent changes that ship together should normally have one coherent Changeset rather than
several implementation-level entries.

Documentation, tests, and internal release infrastructure do not require a Changeset when they do
not alter the published package contract.

## Version pull request

On every push to `main`, `.github/workflows/release.yml` runs `changesets/action` at an immutable
commit. When unreleased Changesets exist, the action creates or updates a version pull request using
GitHub API commit mode. That pull request applies `pnpm version`, updates `package.json` and
`CHANGELOG.md`, and consumes the included Changesets.

The workflow has no publish step, npm token, registry credential, environment, or OIDC permission.
Merging a version pull request cannot publish the package.

The repository setting that allows GitHub Actions to create and approve pull requests must be
enabled before expecting the bot to open the first version pull request.

## Pre-publication validation

From a clean checkout of the exact version commit:

```sh
pnpm install --frozen-lockfile
pnpm release:check
```

`release:check` runs type checking, linting, schema drift checks, all tests, the CLI build, and
`npm pack --dry-run`. Inspect the dry-run manifest and confirm that it contains at least:

- `LICENSE` and `CHANGELOG.md`;
- `AGENTS.md`, `README.md`, and the public documentation;
- the compiled `trust` CLI and runtime packages;
- versioned JSON Schemas; and
- the bundled proof summary.

Install the resulting real tarball into an empty temporary project and exercise `trust --version`,
`trust try`, `trust status --format json`, and a trusted plus insufficient-evidence start flow before
the first public release.

## Publishing boundary

Publishing is intentionally not automated yet. Only a maintainer with explicit release authority
may run:

```sh
pnpm release
```

That command builds the CLI and delegates publication to `changeset publish`. Do not run it from a
feature branch or with uncommitted changes. The first public release should add an npm trusted
publisher and a provenance-backed publish job at a separately reviewed, immutable workflow path;
until then, this repository prepares versions but never publishes them.

After publication, verify the registry version and integrity, install the exact published version in
a clean directory, create the matching Git tag and GitHub release if the publishing mechanism did
not do so, and require exact versions in trust-authority workflows.
