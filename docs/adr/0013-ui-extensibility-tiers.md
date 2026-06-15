# ADR-0013: UI extensibility tiers + layered react packages

**Date**: 2026-05-28
**Status**: Partially superseded (2026-06-09)
**Supersedes (partially)**: nothing - extends ADR-0006 (UI plugin registry)

> **Superseded note (2026-06-09).** The page/block SDK layer described below
> (`@oss/react-pages` / `@oss/react-blocks`) and the reference frontend apps
> (`apps/web` / `apps/backoffice`) were removed from the OSS repo. The platform is
> now headless: the frontend lives in the consumer repo and will be re-extracted from
> it later. `@oss/react` remains the supported frontend
> consumption surface; the `no-sdk-layer-inversion` boundary lint and the `pnpm gen
page` generator were removed with the layer. The historical design below is kept
> for context and will inform the re-extraction.

## Context

`@oss/react-sdk` was a monolithic package containing data hooks, presentational primitives, composed pages, the ui-plugin slot registry, theme, and the server prefetcher entry. The slot system supported only `add` / `prepend` / `replace` with isolated subjects - no shared page context, no RBAC, no brand scoping, no feature flagging. Operator scenarios that didn't fit a slot forced a fork of OSS pages.

We re-evaluated what an operator-extensible UI actually needs (see [Slack canvas: OSS UI Extensibility](https://example.slack.com/docs/T8EUWEKE2/F0B7JNZ6J48) for the alternative options weighed). Five tiers cover the real shape of the work:

| Tier                   | Owner            | Mechanism                                                                                                  |
| ---------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| T0 - config            | ops / compliance | Zod `PlatformConfig` + file loader                                                                         |
| T0.5 - theme           | design           | brand-scoped `ThemeProvider`                                                                               |
| T1 - typed slots       | plugin dev       | `defineUIPlugin` extension points with `visibleWhen` / `requiresPermission` / `brandScope` / `featureFlag` |
| T2 - block composition | app dev          | operator writes own page from OSS blocks + hooks                                                           |
| T3 - page override     | app dev          | `ctx.provide(ClientPageToken, MyImpl)` full replacement                                                    |

Plus cross-cutting helpers (`usePageContext`, `useDataExtension`, `<RoleGate>`) and a compliance ceiling (`SealedToken<T>`) for regulator-mandated services operators may never override.

## Decision

Three architectural changes:

### 1. Split the monolith

`@oss/react-sdk` is deleted. Three layered packages take its place:

| Package             | Contents                                                                                   | Subpaths                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `@oss/react`        | data hooks, transport, auth, UIProvider context, cross-cutting helpers, server prefetchers | `.` (client), `./server` (RSC-only)                                       |
| `@oss/react-blocks` | presentational primitives consuming UIProvider                                             | `./admin`, `./player`                                                     |
| `@oss/react-pages`  | composed pages, ui-plugin registry, theme, OssProviders                                    | `.` (convenience barrel), `./admin`, `./player`, `./ui-plugin`, `./theme` |

The `@oss/react-pages` root barrel re-exports the union of hooks + blocks + ui-plugin for ergonomic migration; subpath imports are required to keep RSC + client cleanly separated (`@oss/react/server` is the only entry safe to import from a Next RSC). Layer DAG enforced by `oss-boundaries/no-sdk-layer-inversion` lint rule.

### 2. Grow the slot contract

`SlotContribution` and `ColumnContribution` gain optional gating props:

- `visibleWhen(ctx)` - runtime predicate
- `requiresPermission` - RBAC check against the current user permission set
- `brandScope` - restrict to specific brand ids
- `featureFlag` - gate by `PlatformConfig.features[key]`

Resolution order in `useSlotFills` / `useSlotColumns`: `featureFlag -> brandScope -> requiresPermission -> visibleWhen -> sort by order`. Pages seed the runtime context via `<SlotEvaluationContextProvider>`.

All gating props are optional with backwards-safe defaults: existing fills keep working with no changes.

### 3. Two new typed tokens + sealed services

`@oss/adapters` gains two phantom-typed token kinds alongside `Token<T>`:

- `SealedToken<T>` - regulator-mandated services operators must never override. Structurally incompatible with `Token<T>`, so `ctx.provide(sealed, ...)` fails typecheck. Belt-and-braces runtime guard in `plugin-host` rejects any token whose Symbol description starts with `sealed:`.
- `ClientPageToken<P>` - Tier 3 escape hatch for full client-side page replacement.

`@oss/compliance-invariants` is the canonical home for the sealed list with regulatory citations per token (UKGC LCCP 3.5, MGA Player Protection, 5AMLD, FATF, etc.). 12 sealed tokens shipped in v1.

## Consequences

- Operators ship feature plugins covering ~80%+ of common scenarios without forking. The reference plugin `@oss/example-vip-tier` exercises every v1 surface as a starter.
- Atomic migration: `@oss/react-sdk` was dropped in one coordinated commit. Downstream operators must update imports in lockstep with the OSS release.
- T0 config admin UI is **deferred to v2**. v1 ships Zod schema + file loader only. 60% of operator "customization" tickets are still actionable via the file.
- T3 page override **seam is shipped but no reference override** is provided in v1 - the contract exists, the demo doesn't.
- The `@oss/compliance-invariants` package is first-class. Operators import it in their own test suites.
- `pnpm verify` boundary lint now enforces the SDK layer DAG.

## Alternatives considered (summary)

| Option                                            | Verdict                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Layered packages + three-tier model**           | **chosen**                                                                   |
| Page-as-plugin (every page replaceable via token) | rejected for now - fights Next RSC; revisit when RSC matures                 |
| Per-feature packages (`@oss/page-lobby`, ...)     | rejected - 20+ packages, premature at current scale                          |
| Headless-only (no JSX in OSS)                     | rejected - violates "fully playable default surface" mission                 |
| Schema-driven UI (pages-as-data)                  | rejected - DSL expressivity wall; revisit if admin explodes to 50+ resources |
| Status quo + targeted polish                      | rejected - doesn't solve "80% of this page" pain                             |

Full sizing in [Slack canvas](https://example.slack.com/docs/T8EUWEKE2/F0B7JNZ6J48).

## References

- [ADR-0006: UI plugin registry](./0006-ui-plugin-registry.md) - the original slot system this extends
- [ADR-0005: Headless backoffice pages](./0005-headless-backoffice-pages.md) - react/react-dom/@tanstack/react-query dedup
- [ADR-0012: Player-front framework - Next.js App Router (RSC)](./0012-player-front-next-rsc.md) - RSC + SSR target for player surface
- [Slack canvas: OSS UI Extensibility](https://example.slack.com/docs/T8EUWEKE2/F0B7JNZ6J48)
- Notion memory: `oss-ui-arch-layering-exploration` (decision)
- `@oss/example-vip-tier` - reference plugin exercising every v1 tier
- `@oss/compliance-invariants` - canonical sealed-token list + regulatory citations
