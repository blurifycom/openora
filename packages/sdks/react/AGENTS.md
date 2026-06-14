# @oss/react-hooks

Leaf SDK package - data hooks, transport, auth, navigation seam, and cross-cutting helpers. The supported frontend consumption surface for the headless platform: the downstream frontend (consumer) consumes the api over HTTP through these hooks and owns its entire UI layer. No UI components ship here. The page/block SDK layer that once sat above it was removed (2026-06-09) and will be re-extracted from consumer later. See ADR-0013.

## Subpaths

| Entry      | What                                                                                                       | Bundled in      |
| ---------- | ---------------------------------------------------------------------------------------------------------- | --------------- |
| `.` (root) | client-only data hooks + helpers; safe wherever React runs                                                 | client bundle   |
| `./server` | RSC-only prefetchers (`prefetchLobby`, `prefetchGames`, `prefetchWallet`). No `'use client'`, no React-DOM | RSC server only |

A consumer's Next App Router route file imports `prefetch*` from `./server` to seed the cache, then renders its own page component (from the frontend repo) to hydrate the client tree.

## What lives here

| Export                                                                                | Purpose                                                                                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `createClient`, `useOrpcClient`, `ApiClientProvider`, `useApiClient`                  | typed oRPC client wiring                                                                                                       |
| `useSession`, `useLogin`, `useLogout`, `useRegister`, `useCurrentUser`                | auth hooks via `@oss/auth` better-auth integration                                                                             |
| `usePaginatedList`                                                                    | generic paginated query wrapper                                                                                                |
| `useEventStream`                                                                      | SSE subscription for real-time surfaces (sportsbook odds, etc)                                                                 |
| `usePageContext<T>`, `PageContextProvider<T>`, `useOptionalPageContext<T>`            | typed page-scoped data sharing - host page exposes its loaded data; slot fills read it. Throws if used outside any provider.   |
| `useDataExtension(pluginId, key, fetcher, args?)`                                     | namespaced TanStack Query slot for plugin-injected data. Two plugins reading the same `(pluginId, key, args)` share one fetch. |
| `RoleGate`                                                                            | declarative role / permission / predicate-gated rendering. UI hiding only - server-side `AdminGuard` is the real authority.    |
| `prefetchLobby`, `prefetchGames`, `prefetchWallet`, `prefetchSportsbook` (`./server`) | RSC server-only prefetchers; build an oRPC client with forwarded cookies and seed a `QueryClient`                              |

## Hard rules

- This is a leaf SDK package - no page/block layer sits above it in this repo (it lives in the consumer frontend repo). It depends only on `@oss/sdk-core`, `@oss/orpc-contract`, and `@oss/auth`.
- `./server` entry must NEVER import a client-side React tree. Only types from `@oss/orpc-contract`, `@oss/sdk-core`, and `node:`/std libs.
- `'use client'` directive is required on every file under `src/` except the `./server` tree.
- Test-only mocks live next to the hook (`hook.test.ts`), not in a separate fixture file.

## How to add a new hook

1. Decide client or server. Client hook -> `src/hooks/use-<name>.ts(x)` with `'use client'`. Server prefetcher -> `src/server/<name>.ts` (no `'use client'`).
2. Use the existing `useOrpcClient()` (client) or `createClient()` (server) for transport - never inline `fetch`.
3. Export from `src/index.ts` (client) or `src/server/index.ts` (server).

## See also

- `@oss/sdk-core` - the framework-agnostic typed client these hooks wrap
- ADR-0012 - player front Next.js App Router (RSC + SSR)
- ADR-0013 - UI extensibility tiers (the page/block layer was removed; see the superseded note in the ADR)
