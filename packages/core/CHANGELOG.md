# @oss/core

## 0.3.0

### Minor Changes

- Fold the 10 domains (casino, cms, compliance, engagement, pam, sportsbook, wallet, iam, audit, admin-console) into the single published `@oss/core` package as subpaths (ADR-0025 phase 2). Consumers now install one package and import `@oss/core/<domain>/{contracts,schema,plugins,server,react}` instead of the per-domain `@oss/<domain>` packages, which are no longer published. First registry release of the folded layout.
