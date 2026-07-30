# React SDK (`@openora/core/react` + domain `react/` dirs)

Detail for the SDK line in `conventions`. Read this when adding or changing a hook, the typed client, auth, or realtime.

Headless repo - only the SDK consumption layer lives here, no UI.

- **One `useX` per concern, returning a plain object** (`{ wallet, isLoading }`).
- **Hand-write `useMemo`/`useCallback` wherever a returned value/function is part of a hook's stability contract** - the OPPOSITE of the consumer-app rule, because the consumer's React Compiler does not reprocess pre-built `node_modules`. Keep hooks Rules-of-React compliant so the consumer's compiler can optimize callers.
- **Server state is not client state** - key/cache/invalidate via the query lib, never a raw `useEffect(fetch)`.
- **A published SDK export annotates its return type** - it is the public contract; an inferred return silently leaks a refactor as a downstream breaking change (see `functions.md`).
- `react` never imports `server` or a module (lint: `no-react-to-runtime`).

```tsx
// bad - fetch in an effect, a new object every render, inferred public return type
export function useWallet(userId: string) {
  const [wallet, setWallet] = useState<Wallet>();
  useEffect(() => {
    fetch(`/api/wallet/${userId}`)
      .then((r) => r.json())
      .then(setWallet);
  }, [userId]);
  return { wallet, refetch: () => {} };
}
// good - query lib owns server state, stability contract hand-memoized, return type explicit
export function useWallet(userId: string): UseWalletResult {
  const { data, isLoading, refetch } = useQuery(walletQuery(userId));
  const reload = useCallback(() => void refetch(), [refetch]);
  return useMemo(() => ({ wallet: data, isLoading, reload }), [data, isLoading, reload]);
}
```

Canonical hooks to copy: `packages/core/src/react/hooks/use-paginated-list.ts` (query + stable return), `use-event-stream.ts` (realtime SSE subscription).
