---
'@oss/core': minor
---

Fold the shared tsconfig presets into `@oss/core` as the `@oss/core/tsconfig/*` subpath and stop publishing the separate `@oss/tsconfig` package. Consumers now extend `@oss/core/tsconfig/{base,node,node-service,nextjs,react-lib}.json` instead of `@oss/tsconfig/...` and drop the `@oss/tsconfig` devDependency.
