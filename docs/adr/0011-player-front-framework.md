# ADR-0011: Player-front framework - Next.js vs TanStack Start

**Date**: 2026-05-28
**Status**: Superseded (2026-06-10)

> **Superseded (2026-06-10):** The entire frontend - all reference apps, player-facing pages, and framework choices - was removed from the OSS repo. The platform is now headless backend only. The frontend exploration (Next.js vs TanStack Start) and its decision are now managed in the consumer repo. This ADR is preserved as historical record.

## Context

The player-facing surface (casino lobby, sportsbook, wallet) needs SSR for first-paint and SEO, and must stay light for low-bandwidth / grey markets (a stated business requirement). The backoffice is a Vite + TanStack Router SPA (no SSR - see `apps/backoffice/` and the scaffolder's sole backoffice variant). The open question was the player app: stay on Next.js (the org knows it) or move to TanStack Start.

A correction that shaped the comparison: as of 2026-05, TanStack's _RSC_ support is still experimental. Its production-ready model is loaders + server functions on Vite, not RSC. So this is "Next App Router (RSC-first)" vs "TanStack Start (loaders + server functions)", not an RSC-vs-RSC race.

## Method

Built the comparison in the consumer (`apps/web` = Next 16, `apps/web-tanstack` = TanStack Start). Both mount the **same** `@oss/react-sdk` pages (lobby, games, sportsbook, wallet, login) with the **same** `daisyuiProvider`, so the only variable is the framework shell. Both fetch SSR data through the identical `@oss/react-sdk/server` fetchers (`fetchLobbyData`, `fetchSportsbookData`), forwarding the player's cookies; the sportsbook page exercises the real-time path (live odds over SSE via `useEventStream`). Bundle sizes are gzipped client JS measured on disk from a production build.

That both shells run the same page bodies unchanged is itself the key finding: the framework choice is low-risk and reversible because the data/page layer (`sdk-core` + react-query + the server fetchers) is framework-agnostic.

## Results

| Criterion                      | Next.js 16 (Turbopack)                                              | TanStack Start (Vite)                                    | Winner                                   |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| Total client JS (gzip)         | ~281 KB                                                             | ~185 KB                                                  | TanStack (~34% smaller)                  |
| Lobby first-load JS (gzip)     | ~270 KB (large shared baseline, split across 99/69/48/39 KB chunks) | ~183 KB (one 175 KB vendor chunk + ~1-3 KB route chunks) | TanStack                                 |
| Production build               | compile ~2.2s + tsc ~1.6s                                           | client ~1.5s + nitro ~1.8s                               | comparable                               |
| Real-time (live-odds SSE)      | works (client page)                                                 | works (client page)                                      | tie                                      |
| SSR data path                  | RSC server component awaits the fetcher                             | route `loader` calls the same fetcher                    | tie (same seam)                          |
| Debugging ergonomics           | RSC couples routing/fetching/render; opaque cache directives        | explicit server functions, no implicit RSC execution     | TanStack (per current community reports) |
| Org familiarity / time-to-ship | ~90% of the org knows Next                                          | new to the org                                           | Next                                     |

LCP on throttled 3G was not rig-measured here; it tracks first-load JS, so the ~90 KB gzip delta predicts a meaningful TanStack advantage on slow links - exactly the low-bandwidth case that motivated the question.

## Decision

**Recommend TanStack Start for the player front**, on two technical grounds: (1) the ~34% smaller client bundle directly serves the low-bandwidth/grey-market requirement, and (2) the loaders + server-functions + SSE model fits a client-heavy, real-time igaming UI better than Next's RSC-first, server-first coupling. The backoffice stays a Vite SPA.

This is **Proposed**, not Accepted: org familiarity and time-to-ship are real, non-technical factors that only the team owns. If those dominate, Next.js remains viable - and because the react-sdk pages proved portable across both shells with zero page changes, the platform supports either, and a later switch is cheap. The scaffolder ships both (`--web=next|tanstack`) so consumers choose per project.

## Consequences

- The OSS default scaffold keeps `--web=next` for back-compat; the reference consumer uses TanStack Start.
  (As of 2026-05-28 this is no longer true - the `--web` flag and the TanStack Start variant were removed. See ADR-0012.)
- TanStack route trees (`routeTree.gen.ts`) are generated on first dev/build (gitignored) - a fresh `tsc --noEmit` fails until `pnpm dev` runs once. Standard TanStack behavior; note it in consumer setup.
- Follow-up: a rig-measured LCP-on-3G pass and the framework-aware `pnpm gen page` generator (currently Next-shaped only).
