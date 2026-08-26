---
"executable-trust-layer": patch
---

Treat nested example Playwright configuration as workspace-local instead of fabricating a root E2E
verifier. The repository now documents and enforces that its focused source modules compile and
release together as one npm package.
