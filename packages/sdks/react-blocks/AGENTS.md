# @oss/react-blocks

Presentational primitives consuming the UIProvider contract. Sits between `@oss/react-hooks` (data) and `@oss/react-pages` (composed pages). See ADR-0013.

## Subpaths

| Entry | What | Status |
|---|---|---|
| `./admin` | `StatCard`, `Skeleton` family, `Pagination`, `TimeSeriesChart`, `AuthGuard`, admin icons | active |
| `./player` | player-surface primitives | future home; empty stub today |

Subpath structure exists so a player bundle (Next) never pulls admin block code and vice versa. Tree-shaking + physical subpaths > one big barrel.

## What lives here

- **Stateless or near-stateless** display primitives - props in, JSX out via `useUI()`.
- May consume data hooks from `@oss/react-hooks` (eg `useCurrentUser` inside `AuthGuard`).
- No page-level layout, no plugin registry, no theme override logic - those belong in `@oss/react-pages`.

## Hard rules

- Layer DAG: blocks may import from `@oss/react-hooks` and `@oss/ui-provider-contract`. May NOT import from `@oss/react-pages`. Enforced by `oss-boundaries/no-sdk-layer-inversion`.
- Every block is a client component (`'use client'`). Server-side rendering happens at the page level (Next RSC) which then hydrates client islands.
- A block must not encode page-specific layout assumptions. If it can't render outside its current call site, it's not a block - it belongs in `@oss/react-pages/admin` or `/player`.
- Use design tokens (`--bo-*` CSS variables defined in `@oss/react-pages/styles.css`) for all colors / spacing / radii - never hardcode hex values.

## How to add a new block

1. Pick the surface: `src/admin/<name>.tsx` or `src/player/<name>.tsx`.
2. Add `'use client'` at the top.
3. Type the props explicitly. Consume `useUI()` from `@oss/react-hooks` to render primitives.
4. Export from the matching `src/<surface>/index.ts` barrel.
5. If the block depends on a runtime context that doesn't exist yet (eg a brand-aware layout), prefer wiring it through `@oss/react-pages` instead of adding a context here - blocks are leaf-ish.

## See also

- `@oss/react-hooks` - the data layer blocks consume
- `@oss/react-pages` - composed pages that compose blocks
- `@oss/ui-provider-contract` / `@oss/ui-provider-daisyui` - the UIProvider shape blocks render against
