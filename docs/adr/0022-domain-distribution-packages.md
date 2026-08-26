# ADR-0022: Six domain distribution packages for downstream publishing

**Date**: 2026-06-14
**Status**: Superseded by ADR-0024 (domain-as-package + distribution tiers). The six-facade surface shipped (registry the private registry, v0.1.0) and remains the live stepping-stone; the long-term target is now domain-as-package - the facade subpaths (`@openora/<domain>/server|react|contracts|migrate`) are kept stable so the fold-in is consumer-non-breaking. Sections below describe the as-shipped facade model.
**Relates to**: ADR-0021 (everything is a standalone add-on), ADR-0020 (gated add-on editions and isolation), ADR-0013 (platform is headless; frontend lives in the consumer), ADR-0007/0014 (transport/job seams).

## Context

The platform is headless backend + a headless React SDK, consumed by a downstream operator that builds all UI in its own repo (see `docs/guides/downstream-consumer.md`). Today the consumer wires the platform through pnpm workspace **links** to ~30 fine-grained, `private: true` packages (`@openora/core`, `@openora/db`, `@openora-addons/sportsbook`, ...). We want to publish to the GitLab project registry now, and to npm later, so the consumer installs versioned artifacts instead of linking a sibling checkout.

Two problems with publishing the source graph as-is:

1. **Granularity** - ~30 published packages is high version/release overhead and leaks internal structure as public API. We do not want every internal refactor to be a breaking change for consumers.
2. **IP boundary** - not everything is open. Features are tagged **Shared IP** vs **Non-shared IP**. Custom games (the operator's first-party game titles), all custom UI, and every vendor adapter (crypto custody, KYC, games aggregation, realtime, sportsbook) are proprietary and must never land in the OSS registry.

ADR-0021 deliberately makes every feature a standalone, isolated `@openora-addons/<name>` package. That isolation is load-bearing and is **not** changed here.

## Decision

### 1. The published surface is six domain _distribution_ packages

| Package               | Rolls up (shared-IP source)                                                                     | Owns its admin API             |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| `@openora/platform`   | core, db, api-runtime, plugin-host, contracts aggregator, auth, i18n, audit, iam/RBAC, settings | -                              |
| `@openora/account`    | identity, profile, player-management, compliance/RG                                             | players, KYC, limits           |
| `@openora/wallet`     | wallet (fiat + crypto), transactions                                                            | payments, approvals            |
| `@openora/casino`     | gaming, aggregator, lobby                                                                       | catalog, providers             |
| `@openora/sportsbook` | sportsbook, odds adapter                                                                        | events, markets, risk          |
| `@openora/engagement` | chat, notifications, bonus, friends, leaderboard, cms                                           | campaigns, content, moderation |

One **fixed** version across all six (Changesets `fixed` group); consumers pin a single range.

### 2. Distribution rollup, not source restructure

The six are thin **facade** packages. Source structure stays exactly as ADR-0021 (standalone `@openora-addons/<name>` + platform packages, dependency-cruiser boundaries intact). Each facade:

- depends on its member packages via `workspace:*`,
- **bundles** them at build (members stay `private: true` and are never published; the facade's tarball is self-contained - `noExternal` the internal `@openora/*` / `@openora-addons/*`),
- **ships the drizzle migrations** of its members,
- exposes runtime-split subpath exports so server code never reaches the browser:

```ts
import { walletPlugin } from '@openora/wallet/server'; // node
import { useWallet } from '@openora/wallet/react'; // browser, headless hooks
import { walletSchemas } from '@openora/wallet/contracts'; // isomorphic
import { walletAdmin } from '@openora/wallet/server/admin'; // backoffice routes
```

Internal modularity is preserved; the public surface is six.

### 3. Shared-IP boundary = publish boundary (two tiers)

- **Tier 1** - the six `@openora/*` domain packages. Shared IP only. GitLab registry, later npm.
- **Tier 2** - everything proprietary (custom games, all custom UI, vendor adapters). Lives in the consumer repo / `@my-igaming/*` scope, its own cadence, **never** published to the OSS registry. Extends a domain through its existing plugin/adapter seams (ADR-0002, ADR-0014). Custom games plug into `@openora/casino`'s game-integration seam (sessions, provably-fair, round balances - which is shared).

### 4. Domain topology

- `iam`/RBAC lives in `@openora/platform` - access control is foundational, not a feature.
- **No monolithic admin package.** Each domain owns its management API under `/server/admin`; the back office is a Tier-2 UI composing those routes, gated by platform RBAC. Avoids an admin package that depends on every domain (an inverted, ever-growing roof).
- `cms` sits in `@openora/engagement` (content + marketing). Soft call; movable to platform.
- Domains are **siblings**: each depends only on `@openora/platform`, never on each other. Cross-domain needs (eg casino debiting wallet) go through events / platform seams - same rule as ADR-0020.

```
platform  <-  account, wallet, casino, sportsbook, engagement
```

### 5. Consumption + local development

- Consumer `.npmrc` maps `@openora` to the GitLab project registry; auth token via env var. Registry versions are the **committed default**.
- Local side-by-side dev (Volod, Klaudia) via a `link:oss` / `unlink:oss` toggle that injects `link:` overrides and hides them with `git update-index --skip-worktree`, so links never dirty git.
- React/react-query dedup is now automatic via registry hoisting (no bundler alias needed, unlike the link setup).
- CI `publish` job authenticates with `CI_JOB_TOKEN`, runs `changeset publish` on release.

## Consequences

- **Build complexity** - each facade needs a bundler (tsup/rollup) that inlines its private members and emits the subpath entrypoints; migrations must be collected and shipped. This is the bulk of the work.
- **Public API is coarser** - consumers import `@openora/casino` not `@openora-addons/gaming`. Internal moves between member packages are non-breaking.
- **Consumer migration** - the consumer's imports and `pnpm-workspace.yaml` overrides change from ~15 fine-grained entries to six; stale entries (`@openora/modules`, `react-hooks`, `sdk-core`, `ui-provider-*`) are dropped.
- **One version** - the whole platform releases together; no cross-package version matrix.
- **ADR-0021 unchanged** - this is a packaging/distribution layer on top of the standalone-add-on source model, not a replacement.

## Open items

- Bundler choice + how migrations are surfaced to the consumer (single `@openora/platform` migrate entry vs per-domain).
- Whether `@openora/contracts` aggregation stays in platform or becomes its own published entry.
- Sportsbook concrete path (EveryMatrix OddsMatrix iframe vs custom frontend) affects how much of `@openora/sportsbook` is real vs adapter-only.
