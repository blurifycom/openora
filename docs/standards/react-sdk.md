# React SDK (`@openora/core/react` + domain `react/` dirs)

Detail for the SDK line in `conventions`. Read this when adding or changing a hook, the typed client, auth, or realtime.

Headless repo - only the SDK consumption layer lives here, no UI.

- **One `useX` per concern, returning a plain object** (`{ wallet, isLoading }`).
- **React Compiler owns memoization.** Keep hook returns simple unless a compiler-unsupported semantic requirement demands otherwise.
- **Server state is not client state** - key/cache/invalidate via the query lib, never a raw `useEffect(fetch)`.
- **A published SDK export annotates its return type** - it is the public contract; an inferred return silently leaks a refactor as a downstream breaking change (see `functions.md`).
- `react` never imports `server` or a module (lint: `no-react-to-runtime`).

Avoid fetching server state in an effect or leaking an inferred public return type.

```tsx
export function useWallet(userId: string) {
  const [wallet, setWallet] = useState<Wallet>();
  useEffect(() => {
    fetch(`/api/wallet/${userId}`)
      .then((r) => r.json())
      .then(setWallet);
  }, [userId]);
  return { wallet, refetch: () => {} };
}
```

Use the query library for server state and declare the public return type.

```tsx
export function useWallet(userId: string): UseWalletResult {
  const { data, isLoading, refetch } = useQuery(walletQuery(userId));
  return { wallet: data, isLoading, refetch };
}
```

Canonical hooks to copy: `packages/core/src/react/hooks/use-paginated-list.ts` (query), `use-event-stream.ts` (realtime SSE subscription).
