---
'@openora/core': minor
---

Fold the shared oxlint config and turbo generators into `@openora/core` and stop publishing the separate `@openora/oxlint-config` and `@openora/turbo-generators` packages. Consumers now extend `@openora/core/oxlint/oxlintrc.json` and re-export `@openora/core/turbo-generators` instead of the standalone packages, and drop those devDependencies (mirrors the `@openora/core/tsconfig/*` fold).
