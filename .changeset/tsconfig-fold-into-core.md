---
'@blurifycom/core': minor
---

Fold the shared tsconfig presets into `@blurifycom/core` as the `@blurifycom/core/tsconfig/*` subpath and stop publishing the separate `@blurifycom/tsconfig` package. Consumers now extend `@blurifycom/core/tsconfig/{base,node,node-service,nextjs,react-lib}.json` instead of `@blurifycom/tsconfig/...` and drop the `@blurifycom/tsconfig` devDependency.
