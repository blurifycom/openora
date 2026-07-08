---
'@openora/core': minor
---

Fold the shared tsconfig presets into `@openora/core` as the `@openora/core/tsconfig/*` subpath and stop publishing the separate `@openora/tsconfig` package. Consumers now extend `@openora/core/tsconfig/{base,node,node-service,nextjs,react-lib}.json` instead of `@openora/tsconfig/...` and drop the `@openora/tsconfig` devDependency.
