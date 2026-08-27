---
"executable-trust-layer": patch
---

Treat nested example Playwright configuration as workspace-local instead of fabricating a root E2E
verifier. The repository now keeps its focused internal modules under one root `src/` tree and
compiles and releases them together as one npm package.
