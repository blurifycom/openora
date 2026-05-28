# ADR-0012: Player-front framework - Next.js App Router (RSC) only

**Date**: 2026-05-28
**Status**: Accepted
**Supersedes**: [ADR-0011](./0011-player-front-framework.md)

## Context

ADR-0011 proposed TanStack Start (Vite + loaders + server functions) for the player front, based on a ~34% smaller client bundle in a head-to-head with Next.js 16. It was Proposed, not Accepted - org familiarity and time-to-ship were left as open factors.

Re-evaluating in the same week with two updated constraints from the platform owner:

1. **SSR (or RSC) is required wherever it's possible on player-facing pages.** Lobby, game tiles, promotions, sportsbook landing, the SEO-bearing surfaces. RSC is preferred over plain SSR because it eliminates the JS payload for components that never need client interactivity.
2. **The backoffice does not need SSR.** It is behind auth, has no SEO, and the Vite SPA dev loop is faster.

TanStack Start's RSC support is still experimental as of 2026-05; its production-ready model is loaders + server functions. So in an "RSC is the goal" framing, the comparison is no longer apples-to-apples.

## Decision

**Player front = Next.js App Router (RSC-first).** Backoffice stays Vite + TanStack Router SPA. Drop the TanStack Start variant from the consumer scaffolder.

## Why

| Constraint | Next.js App Router | TanStack Start |
|---|---|---|
| Production RSC support | mature (the reference implementation) | experimental as of 2026-05 |
| Server-rendered first paint for SEO surfaces (lobby, promo, sportsbook landing) | RSC + streaming + suspense | SSR via loader (works), no RSC |
| Eliminate JS for non-interactive components | yes, RSC excludes them from the bundle | no, everything ships to the client |
| Image / font optimization | built in | manual |
| Org familiarity | ~90% of the team | new to the team |
| Server actions / form posts without a separate API roundtrip | yes | not first-class |
| Bundle size (gzipped client JS, head-to-head from ADR-0011) | ~281 KB | ~185 KB |

Bundle size is the one real cost of this decision. We accept it for the RSC mandate; the Next bundle is reducible with route-level code-splitting and a `loading.tsx` skeleton if first-load JS becomes a measured problem on the grey-market low-bandwidth target.

## Data flow on the player surface

The `@oss/react-sdk` pages remain React client components (they use hooks, query client, slot system, theme). The Next consumer's route file is the RSC: it prefetches data server-side and hydrates the client page.

```tsx
// apps/web/app/lobby/page.tsx  (Next RSC - runs on server)
import { PlayerLobbyPage, prefetchLobby } from '@oss/react-sdk';
import { HydrationBoundary, dehydrate, QueryClient } from '@tanstack/react-query';

export default async function Page() {
  const qc = new QueryClient();
  await prefetchLobby(qc);
  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <PlayerLobbyPage />
    </HydrationBoundary>
  );
}
```

`prefetchLobby`, `prefetchGames`, `prefetchWallet`, etc., live in `packages/sdks/react-sdk/src/server/`. They run server-only (no `'use client'`, no React tree), build an oRPC client via `@oss/sdk-core`, forward request cookies, and seed the query cache. A static-feel page (about, terms, promo landing) is plain RSC in the consumer's Next app with no SDK involvement.

## Consequences

- The scaffolder no longer takes a `--web` flag. `apps/web` is always Next App Router. The `tools/templates/variants/web-tanstack/` tree is deleted.
- ADR-0011 is Superseded - kept on disk for the bundle-size comparison data.
- The `@oss/react-sdk/server` entry stays Next-only (it does not need to be portable across frameworks any more); its module-level comment is updated accordingly.
- Existing references to "Next.js or TanStack Start" across docs / agents / templates are normalized to "Next.js App Router (RSC + SSR)".
- The `pnpm gen page` consumer generator stays Next-shaped (Next route shim `apps/web/app/<route>/page.tsx`); the follow-up about making it framework-aware is now scoped to a Next-vs-backoffice surface check instead of a 3-way framework matrix.

## Re-evaluation trigger

Reopen this decision if (a) Next App Router's RSC model regresses materially, or (b) a measured first-load-JS problem on the 3G grey-market target cannot be solved with code-splitting + a `loading.tsx` skeleton.

## References

- [ADR-0005: Headless backoffice pages](./0005-headless-backoffice-pages.md) - the react/react-dom/@tanstack/react-query dedup pattern
- [ADR-0011: Player-front framework (Superseded)](./0011-player-front-framework.md) - the bundle comparison this decision overrides
- [docs/downstream-consumer.md](../downstream-consumer.md) - consumer scaffolder + linking
