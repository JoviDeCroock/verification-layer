# Internal source modules

The directories below this one are implementation modules of the single
`executable-trust-layer` package. They are not pnpm workspace packages and are not independently
versioned or published.

The repository root owns the package manifest, dependencies, version, license, Changesets, build,
and release process. Internal modules use relative imports and compile together into
`dist/packages/`; the supported installed-package surface is the `trust` executable declared by the
root `package.json`.

Keeping these boundaries as directories still makes ownership and dependencies visible without
creating package identities or public APIs that the project does not intend to maintain. If an
internal module ever needs independent publication, first define its public contract and remove
dependency cycles before adding it to the pnpm workspace.
