# Security policy

Executable Trust Layer handles repository commands, change provenance, signing keys, and merge
authority. Please do not disclose a suspected vulnerability in a public issue, discussion, or pull
request.

Before public visibility, use an existing private maintainer channel. At public launch, enable and
use GitHub's private vulnerability reporting for this repository. Include the affected version or
commit, the trust boundary involved, reproduction steps, impact, and any suggested mitigation. Do
not include live credentials, private signing keys, or third-party data; use synthetic fixtures.

The latest released version and the current `main` branch receive security fixes. Older preview
versions may be asked to upgrade when a fix cannot be backported safely.

The documented security assumptions and non-goals are in [docs/threat-model.md](docs/threat-model.md).
Receiving a report does not imply that a behavior is a vulnerability, but reports will be evaluated
against that threat model and the product's fail-closed guarantees.
