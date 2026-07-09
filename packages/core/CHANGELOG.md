# @openora/core

## 0.4.0

### Minor Changes

- 8dc63fd: Fold the shared oxlint config and turbo generators into `@openora/core` and stop publishing the separate `@openora/oxlint-config` and `@openora/turbo-generators` packages. Consumers now extend `@openora/core/oxlint/oxlintrc.json` and re-export `@openora/core/turbo-generators` instead of the standalone packages, and drop those devDependencies (mirrors the `@openora/core/tsconfig/*` fold).
- 17b8c9a: Single-tenant platform (ADR-0026): the `tenantId` column, RLS, the two-role
  connection split, and server-side tenant resolution are removed. Backoffice RBAC

  - a `(role x module) -> level` permission matrix with super-admin semantics. A shared offset-pagination kit (`@openora/core/contracts/kit`:
    `PageQuerySchema` + `paginated`) with list endpoints returning
    `{ items, total, page, limit }`.

  BREAKING CHANGE: `createApp` no longer accepts `resolveTenant`; `getTenantId` is
  removed. The DB has no incremental path from the multi-tenant schema - recreate
  from the new single-tenant baselines.

- 70dd6b9: Fold the shared tsconfig presets into `@openora/core` as the `@openora/core/tsconfig/*` subpath and stop publishing the separate `@openora/tsconfig` package. Consumers now extend `@openora/core/tsconfig/{base,node,node-service,nextjs,react-lib}.json` instead of `@openora/tsconfig/...` and drop the `@openora/tsconfig` devDependency.

## 0.3.0

### Minor Changes

- Fold the 10 domains (casino, cms, compliance, engagement, pam, sportsbook, wallet, iam, audit, admin-console) into the single published `@openora/core` package as subpaths (ADR-0025 phase 2). Consumers now install one package and import `@openora/core/<domain>/{contracts,schema,plugins,server,react}` instead of the per-domain `@openora/<domain>` packages, which are no longer published. First registry release of the folded layout.
