# @oss/react

Leaf SDK package - data hooks, typed oRPC client, auth, and client-side realtime transport. The supported frontend consumption surface for the headless platform: the downstream frontend consumes the api over HTTP through these hooks and owns its entire UI layer. No UI components ship here. The page/block SDK layer and the RSC prefetcher/slot helpers that once sat above it were removed (2026-06-09) and will be re-extracted later. See ADR-0013.

## What lives here

| Export                                                                           | Purpose                                                                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `createClient`, `contract`, `useOrpcClient`, `ApiClientProvider`, `useApiClient` | typed oRPC client wiring                                                                                           |
| `useSession`, `useLogin`, `useLogout`, `useRegister`, `useCurrentUser`           | auth hooks via `@oss/auth` better-auth integration                                                                 |
| `useEnable2fa`, `useVerify2fa`, `usePlayerProfile`, `useUpdateProfile`, ...      | account / 2FA / profile hooks (see `hooks/account.ts`)                                                             |
| `usePaginatedList`                                                               | generic paginated query wrapper                                                                                    |
| `useEventStream`                                                                 | SSE subscription for real-time surfaces (sportsbook odds, etc)                                                     |
| `useChatStream`                                                                  | chat-message SSE subscription                                                                                      |
| `RealtimeClientProvider`, `useOptionalRealtimeClient`                            | pluggable client-side realtime transport (consumer injects Ably/GetStream; default is built-in SSE). See ADR-0007. |

PAM admin hooks are an add-on surface (the `player.*` admin contract lives in `@oss-addons/player-management`) - not part of the free SDK. See ADR-0020.

## Hard rules

- This is a leaf SDK package - no page/block layer sits above it in this repo (it lives in the downstream consumer frontend repo). It depends only on `@oss/orpc-contract` and `@oss/auth`.
- Client-only: `'use client'` is required on every file under `src/`. No RSC/server entry ships from this package.
- Test-only mocks live next to the hook (`hook.test.ts`), not in a separate fixture file.

## How to add a new hook

1. Add `src/hooks/use-<name>.ts(x)` with `'use client'`.
2. Use the existing `useOrpcClient()` for transport - never inline `fetch`.
3. Export from `src/index.ts`.

## See also

- ADR-0007 - realtime transport seam
- ADR-0013 - UI extensibility tiers (the page/block layer was removed; see the superseded note in the ADR)
