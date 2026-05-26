# @oss/react-sdk

The React platform package. Everything a Next.js consumer needs to talk to the OSS API and render the admin: a typed client, query hooks, auth, the UI-adapter context, the theme system, the admin shell + pages, and a UI plugin registry.

This package absorbed the former `@oss/client` (typed transport) and `@oss/backoffice-ui` (admin UI). If you're looking for either, it's here now. The reference consumer apps live at `apps/backoffice/` (admin) and `apps/web/` (player).

## What's in the box

| Export                                                                                 | Kind               | Purpose                                                                                                                  |
| -------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `createClient({ baseUrl, headers?, fetch? })`                                          | factory            | Typed oRPC client over the contract. Framework-agnostic.                                                                 |
| `OssClient`                                                                            | type               | The client's type. Methods inferred from contract schemas.                                                               |
| `contract`                                                                             | re-export          | The composed oRPC contract.                                                                                              |
| `ApiClientProvider`, `useApiClient`                                                    | context            | Holds `baseUrl`; provides a raw `.get/.post/.patch/.delete` fetch wrapper.                                               |
| `useOrpcClient`                                                                        | hook               | Returns a memoized `OssClient` built from `useApiClient().baseUrl`. Prefer this over the raw client for contract routes. |
| `useSession`, `useLogin`, `useLogout`, `useRegister`, `useCurrentUser`                 | hooks              | Auth, on TanStack Query.                                                                                                 |
| `UIProvider`, `useUI`                                                                  | context            | Inject a UI adapter (eg `shadcnProvider`). Pages read components via `useUI()`.                                          |
| `ThemeProvider`, `useTheme`, `themeToCssVars`, `defaultTheme`, `themePresets`, `Theme` | theme              | Token system. Override per-tenant.                                                                                       |
| `AppShell`, `AuthGuard`, `StatCard`                                                    | components         | Admin shell.                                                                                                             |
| `LoginPage`, `DashboardPage`, `UsersListPage`, `UserDetailPage`, `GamesPage`           | components         | Admin page bodies.                                                                                                       |
| `defineUIPlugin`, `UIPluginProvider`, `RegisteredRoute`, `use*` registry hooks         | plugin registry    | Extend the admin without forking (ADR-0006).                                                                             |
| `./styles.css`                                                                         | side-effect import | The design system. Import once in the root layout.                                                                       |

## Layering (do not break)

```
@oss/orpc-contract        ← Zod schemas + route shapes (source of types)
@oss/ui-provider-contract ← UIProvider interface (Button, Input, DataTable, ...)
        ▲
        │ depends on both, NOT on any UI adapter
@oss/react-sdk            ← this package. Renders via useUI(); adapter-agnostic.

@oss/ui-provider-shadcn   ← one adapter (typed `shadcnProvider: UIProvider`)
@oss/ui-provider-mui      ← future adapter, same interface
```

- This package depends on `@oss/ui-provider-contract` (the interface), never on a concrete adapter. Don't add `@oss/ui-provider-shadcn` to dependencies. The consumer picks the adapter and passes it to `<UIProvider value={...}>`.
- Types come from `@oss/orpc-contract` via `z.infer`. Don't hand-write a `type X = {...}` for an API response; import the schema.
- The typed client (`useOrpcClient`) is preferred for contract routes. The raw `useApiClient()` exists for non-contract routes (eg a plugin's own endpoints) and for reading `baseUrl`.

## How a consumer mounts the admin

Consumers own the Next route files (App Router is filesystem-driven). Route files are server components rendering a client page body:

```tsx
// app/admin/(authed)/users/[id]/page.tsx (server component)
import { UserDetailPage } from '@oss/react-sdk';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UserDetailPage id={id} usersPath="/admin/users" />;
}
```

Root providers (client component):

```tsx
'use client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiClientProvider, UIProvider, ThemeProvider, UIPluginProvider } from '@oss/react-sdk';
import { shadcnProvider } from '@oss/ui-provider-shadcn';
import '@oss/react-sdk/styles.css';

export function Providers({ children }) {
  const [qc] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={qc}>
      <ApiClientProvider client={{ baseUrl: process.env.NEXT_PUBLIC_API_URL! }}>
        <ThemeProvider preset="editorialBrass">
          <UIProvider value={shadcnProvider}>
            <UIPluginProvider
              plugins={
                [
                  /* defineUIPlugin contributions */
                ]
              }
            >
              {children}
            </UIPluginProvider>
          </UIProvider>
        </ThemeProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
```

Reference: `apps/backoffice/` (`@oss/backoffice`, admin) and `apps/web/` (`@oss/web`, player) - working Next apps.

## RSC pattern

Route `page.tsx` and group `layout.tsx` are server components. They render client page bodies / `<AuthGuard><AppShell/>`. Interactive bodies (hooks, dialogs, forms) are client - mandatory because of cookie auth + TanStack Query. Don't add `'use client'` to route files. SSR data prefetch is not wired yet (cookie-forwarding plumbing needed); pages fetch client-side.

## Theming

Every visual token is a `--bo-*` CSS custom property in `styles.css`. `ThemeProvider` injects overrides on a wrapping div - tokens cascade, no rebuild.

```tsx
<ThemeProvider preset="midnightSapphire">...</ThemeProvider>   // named preset
<ThemeProvider theme={{ accent: '#cd853f', radius: '6px' }}>   // partial override
<ThemeProvider theme={dbThemeRow}>                              // per-tenant from API
```

Presets: `editorialBrass` (default), `midnightSapphire`, `veronaCrimson`, `porcelain` (light). To add a token: add the `--bo-*` var to `styles.css` AND a typed field to `Theme` + `themeToCssVars` in `theme.tsx`.

## UI plugin registry (extend without forking)

A plugin contributes admin UI via a client-side `defineUIPlugin`. Full design: ADR-0006.

### Named slots

All injection points are named slots. Import `SLOTS` for autocomplete - never use bare strings.
The MCP `list-extension-points` tool lists all available slots.

**Fill a component slot** (sections, tiles, actions, toolbar):
```tsx
import { defineUIPlugin, defineSlotFill, SLOTS } from '@oss/react-sdk';
import type { Player } from '@oss/shared-schemas';

export const myUI = defineUIPlugin({
  id: 'my-feature',

  nav: [{ href: '/admin/x', label: 'X', icon: XIcon }],

  routes: [{ path: '/admin/x', element: <XPage /> }],

  slots: [
    // Append a section to the player detail page
    {
      name: SLOTS.playerDetail.sections,
      id: 'my-section',
      mode: 'append',
      order: 40,
      render: defineSlotFill<Player>(player => <MySection player={player} />),
    },
    // Replace the entire dashboard tiles area
    {
      name: SLOTS.dashboard.tiles,
      id: 'custom-tiles',
      mode: 'replace',
      render: () => <MyCustomTiles />,
    },
    // Prepend a button to the users toolbar
    {
      name: SLOTS.users.toolbar,
      id: 'export-btn',
      mode: 'prepend',
      render: () => <ExportButton />,
    },
  ],

  columns: [
    { name: SLOTS.players.columns, key: 'badge-count', header: 'Badges', render: v => <BadgeCount id={v as string} /> },
  ],
});
```

**Fill modes:**
- `'append'` (default) - renders after page default content
- `'prepend'` - renders before page default content
- `'replace'` - replaces page default content entirely (last fill by order wins)

Each fill is wrapped in an error boundary - a crashing fill is silenced without taking down the page.

### Declare a new slot in a page

No core files need changing. Just add `<Slot>` anywhere in a page:

```tsx
import { Slot, SLOTS } from '@oss/react-sdk';

// In a page component:
<Slot name={SLOTS.playerDetail.sections} subject={player}>
  <DefaultSection player={player} />   {/* shown when no replace fill is active */}
</Slot>
```

To add a new named slot: add it to `src/ui-plugin/slots.ts` (the `SLOTS` constant), then use `<Slot name={SLOTS.x.y} />` in the page. No other files change.

### SSR contract

Plugin render functions run during SSR (Next.js SSRs client components to HTML). Do not access `window`, `document`, or browser-only APIs at render time - defer those to `useEffect`.

### Plugin files

A plugin's UI file (`ui.tsx`) is separate from its server `plugin.ts` (ADR-0002). They share an `id` but no code. The server file runs in Nest; the UI file runs in the browser.

Pass plugins as a **stable module-level array** to `<UIPluginProvider>` - never inline in JSX (new array reference per render re-runs `buildRegistry` and resets error boundaries):

```tsx
// providers.tsx
const plugins = [myUI, otherUI]; // module-level constant
<UIPluginProvider plugins={plugins}>...</UIPluginProvider>
```

For a registered route, stub a Next file: `export default () => <RegisteredRoute path="/admin/x" />`.

## File layout

```
src/
├── index.ts                  # barrel
├── client.ts                 # createClient, OssClient (typed oRPC transport)
├── theme.tsx                 # Theme, ThemeProvider, presets
├── ui-provider.tsx           # UIProvider, useUI
├── styles.css                # design system (--bo-* vars + component skins)
├── context/
│   └── api-client.tsx        # ApiClientProvider, useApiClient (raw fetch + baseUrl)
├── hooks/
│   ├── auth.ts               # useSession/useLogin/useLogout/useRegister
│   ├── user.ts               # useCurrentUser
│   └── use-orpc-client.tsx   # useOrpcClient (typed client from baseUrl)
├── shell/
│   ├── app-shell.tsx · auth-guard.tsx · stat-card.tsx · icons.tsx
├── pages/
│   ├── admin/                # login · dashboard · users · user-detail · games · players*
│   └── player/               # lobby · games · wallet
└── ui-plugin/
    ├── context.ts            # UIPluginContext, UIRegistry, SlotFill types
    ├── define.ts             # defineUIPlugin, buildRegistry
    ├── registry.tsx          # UIPluginProvider, useUIRegistry, useNavItems, RegisteredRoute
    ├── slot.tsx              # <Slot>, useSlotFills, useSlotColumns, defineSlotFill
    ├── slots.ts              # SLOTS constant - all named slot names (source of truth)
    └── index.ts
```

Reference consumer apps live in the repo's `apps/` (not inside this package):
`apps/backoffice` (`@oss/backoffice`, admin) and `apps/web` (`@oss/web`, player).

## Dependencies

| Kind                                                                   | Why                                                                                                                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@orpc/client`, `@orpc/openapi-client`, `@orpc/contract` (deps)        | typed client transport                                                                                                                                                                            |
| `@oss/orpc-contract` (dep)                                             | inferred types + the contract object                                                                                                                                                              |
| `@oss/ui-provider-contract` (dep)                                      | the `UIProvider` interface                                                                                                                                                                        |
| `@oss/shared-schemas` (dep)                                            | shared schemas used by auth/user hooks                                                                                                                                                            |
| `@tanstack/react-query`, `next`, `react`, `react-dom` (optional peers) | provided by the consumer; optional in `peerDependenciesMeta` so pnpm doesn't duplicate them into this package's `node_modules` (which would split React Context across `link:`-linked workspaces) |

## What NOT to do

- Don't import a concrete UI adapter here. Go through `useUI()`.
- Don't hand-write API response types. Import the Zod schema from `@oss/orpc-contract` and `z.infer`.
- Don't add server-only code. This package ships client components.
- Don't add `'use client'` to consumer route files - keep them server components rendering client bodies.
- Don't put a feature's domain UI here if it's plugin-specific - use `defineUIPlugin` in the plugin instead.
- Don't import from the barrel (`@oss/react-sdk`) inside this package - use relative paths; the barrel pulls `next/navigation` and would create cycles.

## Build

```bash
pnpm -F @oss/react-sdk build       # tsc -> dist/ (ESM)
pnpm -F @oss/react-sdk typecheck
```

CSS ships as raw `src/styles.css` (no PostCSS) so consumers override `--bo-*` vars without a build step. The `examples/` folder is excluded from the package build.
