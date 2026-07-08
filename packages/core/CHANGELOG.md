# @openora/core

## 0.3.0

### Minor Changes

- Fold the 10 domains (casino, cms, compliance, engagement, pam, sportsbook, wallet, iam, audit, admin-console) into the single published `@openora/core` package as subpaths (ADR-0025 phase 2). Consumers now install one package and import `@openora/core/<domain>/{contracts,schema,plugins,server,react}` instead of the per-domain `@openora/<domain>` packages, which are no longer published. First registry release of the folded layout.
