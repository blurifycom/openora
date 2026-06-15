# ADR-0023: The platform is headless — the frontend lives in the consumer

**Date**: 2026-06-14
**Status**: Accepted; implemented.
**Supersedes (the frontend surface of)**: [ADR-0003](./0003-headless-ui-provider.md), [ADR-0005](./0005-headless-backoffice-pages.md), [ADR-0006](./0006-ui-plugin-registry.md), [ADR-0011](./0011-player-front-framework.md), [ADR-0012](./0012-player-front-next-rsc.md), [ADR-0013](./0013-ui-extensibility-tiers.md) (partially).
**Relates to**: [ADR-0022](./0022-domain-distribution-packages.md) (six domain distribution packages), [ADR-0008](./0008-player-admin-split-flat-paths.md) (player/admin split at the SDK layer).

## Context

A run of earlier ADRs (0003, 0005, 0006, 0011, 0012, 0013) designed an OSS-shipped
frontend: a UI provider contract, headless backoffice pages, a client-side UI plugin
registry, layered react SDK packages (`@oss/react-sdk` → `@oss/react-pages` /
`@oss/react-blocks`), reference apps (`apps/web`, `apps/backoffice`), and a player-front
framework choice (Next.js RSC). Each was retired piecemeal via superseded-notes (mostly
dated 2026-06-09/06-10), but the underlying **decision** — _why_ the OSS repo no longer
owns any frontend — was never recorded as its own ADR. That left the strategic call
implicit and scattered, even though it underpins ADR-0022 (what gets published) and the
whole shared-IP / Tier-2 split.

This ADR records that decision explicitly.

## Decision

**The OSS platform is headless backend only.** It ships modules, contracts, adapter
seams, and a single **headless** consumption SDK (`@oss/react`: data hooks, auth,
transport, cross-cutting helpers — no presentational components, no pages, no admin
shell, no slot/registry). The OSS repo contains **no** player web app, **no** backoffice
app, and **no** UI framework choice.

The **entire frontend is the consumer's**: player web, admin/backoffice UI,
component library, design system, theme, styling, SSR/hydration strategy, and the
framework decision (Next.js / TanStack / other) all live in the consumer repo and
consume the OSS API over HTTP through the typed oRPC client in `@oss/react`.

Consequences for the removed surface:

- `@oss/react-sdk`, `@oss/react-pages`, `@oss/react-blocks`, `@oss/ui-provider-*`, and
  the reference `apps/web` / `apps/backoffice` are removed. `@oss/react` is the only
  supported frontend surface.
- The client-side UI plugin registry (`defineUIPlugin`, slots, RBAC-scoped UI extension)
  is **not** part of OSS today. If a shared UI layer is ever re-extracted from the
  consumer, a new ADR will redesign it.
- The player/admin distinction stays where ADR-0008 put it — at the SDK/app layer over
  flat wire paths — not in the wire contract.

## Why this won

- **Shared-IP boundary.** The frontend is where almost all proprietary, brand-specific,
  non-shared IP lives (custom UI, custom games, vendor-specific screens). Keeping it out
  of OSS makes the shared-vs-proprietary line clean and is the precondition for publishing
  OSS as open, reusable packages (ADR-0022).
- **No framework lock-in for consumers.** A headless API + typed client lets each operator
  pick its own rendering stack; OSS does not impose Next/TanStack/RSC on them.
- **Smaller, stabler public surface.** OSS owns contracts and hooks (stable, isomorphic),
  not pixels (churny, opinionated). Fewer breaking changes for consumers.

## Reversibility

Cheap to extend, not to undo. Re-introducing an OSS-owned UI layer later is an additive
re-extraction from the consumer (new packages + a fresh ADR), not a reversal — the
headless API and `@oss/react` contract stay valid either way.
