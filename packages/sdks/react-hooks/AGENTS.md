# @oss/react-hooks

Leaf SDK package - data hooks, transport, auth, UIProvider context, and cross-cutting helpers consumed by `@oss/react-blocks` and `@oss/react-pages`. See ADR-0013.

## Subpaths

| Entry | What | Bundled in |
|---|---|---|
| `.` (root) | client-only data hooks + helpers; safe wherever React runs | client bundle |
| `./server` | RSC-only prefetchers (`prefetchLobby`, `prefetchGames`, `prefetchWallet`). No `'use client'`, no React-DOM | RSC server only |

A Next App Router route file imports BOTH (`prefetch*` from `./server` to seed the cache, the page component from `@oss/react-pages` to hydrate the client tree).

## What lives here

| Export | Purpose |
|---|---|
| `createClient`, `useOrpcClient`, `ApiClientProvider`, `useApiClient` | typed oRPC client wiring |
| `useSession`, `useLogin`, `useLogout`, `useRegister`, `useCurrentUser` | auth hooks via `@oss/auth` better-auth integration |
| `useUI`, `UIProvider` | UIProvider context (provides `Button`/`DataTable`/etc primitives to blocks + pages) |
| `usePaginatedList` | generic paginated query wrapper |
| `useEventStream` | SSE subscription for real-time surfaces (sportsbook odds, etc) |
| `usePageContext<T>`, `PageContextProvider<T>`, `useOptionalPageContext<T>` | typed page-scoped data sharing - host page exposes its loaded data; slot fills read it. Throws if used outside any provider. |
| `useDataExtension(pluginId, key, fetcher, args?)` | namespaced TanStack Query slot for plugin-injected data. Two plugins reading the same `(pluginId, key, args)` share one fetch. |
| `RoleGate` | declarative role / permission / predicate-gated rendering. UI hiding only - server-side `AdminGuard` is the real authority. |
| `prefetchLobby`, `prefetchGames`, `prefetchWallet`, `prefetchSportsbook` (`./server`) | RSC server-only prefetchers; build an oRPC client with forwarded cookies and seed a `QueryClient` |

## Hard rules

- Leaf in the SDK layer DAG (`react-pages -> react-blocks -> react-hooks`). May NOT import from `@oss/react-blocks` or `@oss/react-pages`. Enforced by `oss-boundaries/no-sdk-layer-inversion`.
- `./server` entry must NEVER import a client-side React tree. Only types from `@oss/orpc-contract`, `@oss/sdk-core`, and `node:`/std libs.
- `'use client'` directive is required on every file under `src/` except the `./server` tree.
- Test-only mocks live next to the hook (`hook.test.ts`), not in a separate fixture file.

## How to add a new hook

1. Decide client or server. Client hook -> `src/hooks/use-<name>.ts(x)` with `'use client'`. Server prefetcher -> `src/server/<name>.ts` (no `'use client'`).
2. Use the existing `useOrpcClient()` (client) or `createClient()` (server) for transport - never inline `fetch`.
3. Export from `src/index.ts` (client) or `src/server/index.ts` (server).
4. Re-export from the convenience barrel at `@oss/react-pages` if it's worth pre-bundling for downstream consumers.

## See also

- `@oss/react-blocks` - the presentational layer consuming these hooks
- `@oss/react-pages` - composed pages + ui-plugin registry built on top of hooks + blocks
- ADR-0012 - player front Next.js App Router (RSC + SSR)
- ADR-0013 - UI extensibility tiers (T0 config, T0.5 theme, T1 slots, T2 blocks, T3 page override)
