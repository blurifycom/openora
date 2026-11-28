# React SDK (`@openora/core/react` + domain `react/` dirs)

Detail for the SDK line in `conventions`. Read this when adding or changing a hook, the typed client, auth, or realtime.

Headless repo - only the SDK consumption layer lives here, no UI.

- **One `useX` per concern, returning a plain object** (`{ wallet, isLoading }`).
- **React Compiler owns memoization.** Keep hook returns simple unless a compiler-unsupported semantic requirement demands otherwise.
- **Server state is not client state** - key/cache/invalidate via the query lib, never a raw `useEffect(fetch)`.
- **A published SDK export annotates its return type** - it is the public contract; an inferred return silently leaks a refactor as a downstream breaking change (see `functions.md`).
- `react` never imports `server` or a module (lint: `no-react-to-runtime`).

A hook never fetches server state in an effect with local state and a stubbed refetch, and never leaks an inferred public return type.

A hook reads server state through the query library and declares its public return type, carrying loading state and a real refetch.

Canonical hooks to copy: `packages/core/src/react/hooks/use-paginated-list.ts` (query), `use-event-stream.ts` (realtime SSE subscription).
