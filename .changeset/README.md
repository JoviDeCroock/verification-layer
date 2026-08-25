# Changesets

This folder is managed by [`@changesets/cli`](https://github.com/changesets/changesets). A changeset
records the package affected by a change, its semantic-version impact, and the changelog entry that
will ship with it.

Create one for every user-visible package change:

```sh
pnpm changeset
```

Select `executable-trust-layer`, choose `patch`, `minor`, or `major`, and describe the outcome for
users. Documentation, tests, and internal release infrastructure that do not change the published
package contract do not require a changeset.

The release-preparation workflow follows Pracht's GitHub API commit mode. Changes merged to `main`
produce or update a version pull request; this repository deliberately does not publish from that
workflow. Publishing remains an explicit maintainer action.
