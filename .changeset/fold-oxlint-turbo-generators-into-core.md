---
'@blurifycom/core': minor
---

Fold the shared oxlint config and turbo generators into `@blurifycom/core` and stop publishing the separate `@blurifycom/oxlint-config` and `@blurifycom/turbo-generators` packages. Consumers now extend `@blurifycom/core/oxlint/oxlintrc.json` and re-export `@blurifycom/core/turbo-generators` instead of the standalone packages, and drop those devDependencies (mirrors the `@blurifycom/core/tsconfig/*` fold).
