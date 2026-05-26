# ADR-0006: UI plugin registry (client-side `defineUIPlugin`)

**Date**: 2026-05-20
**Status**: Accepted

## Context

The platform already has a server-side plugin host: `definePlugin({ id, register(ctx) { ctx.routers.add(...); ctx.providers.add(...); ctx.events.on(...) } })` (ADR-0002). It runs at API startup; each module / overlay contributes routers, services, event handlers, prisma extensions.

> **Update (2026-05):** the Drizzle migration removed `ctx.prisma.extend`. Overlays now add their own `pgTable` in their module's `src/schema/index.ts`; the plugin registry no longer exposes a `prisma` surface. References to "prisma extensions" / `prisma.partial.prisma` below are historical.

After ADR-0005 (headless backoffice pages in `@oss/react-sdk`), every consumer mounts the same admin shell + pages. There is no clean way for a plugin to add a column to the Users table, a tile to the dashboard, a tab to the user detail page, or a route to the admin nav. A consumer that wants any of these would have to fork the page component.

Forking is the antithesis of the plugin model the rest of the codebase uses.

## Decision

Introduce a **client-side UI plugin registry** in `@oss/react-sdk`. New API:

```tsx
import { defineUIPlugin, UIPluginProvider } from '@oss/react-sdk';

export const vipTiersUI = defineUIPlugin({
  id: 'vip-tiers',
  register(ctx) {
    ctx.nav.add({ href: '/admin/vip', label: 'VIP', icon: VipIcon });
    ctx.users.columns.add({
      key: 'vipTier',
      header: 'VIP',
      render: (_, u) => <VipBadge user={u} />,
    });
    ctx.users.toolbar.add(<ExportVipReportButton />);
    ctx.userDetail.sections.add({
      id: 'vip',
      title: 'VIP profile',
      render: (u) => <VipSection user={u} />,
    });
    ctx.dashboard.tiles.add({ id: 'vip-revenue', render: () => <VipRevenueTile /> });
    ctx.routes.add({ path: '/admin/vip', element: <VipPage /> });
  },
});

// In the consumer's providers tree:
<UIPluginProvider plugins={[vipTiersUI, kycUI, supportUI]}>...</UIPluginProvider>;
```

Each page in `@oss/react-sdk` reads from the registry at render time via internal hooks (`useNavItems`, `useUserColumns`, etc.) and renders the registered contributions inline alongside its own defaults.

### Why client-side (not the server `definePlugin`)

Server plugins register Nest providers, oRPC routers, BullMQ handlers, Prisma extensions - none of which exist in the browser. A naive shared `definePlugin` would force `register(ctx)` to deal with both worlds; the ergonomic loser is the UI author who'd have to know about Nest types.

Keep the two worlds separate. A "vip-tiers" feature contributes a server `definePlugin` AND a client `defineUIPlugin`. They share an `id` for traceability but live in different files. This mirrors how Next.js separates server and client components.

## Slot taxonomy (v1)

| Namespace                 | Slots                         | Purpose                                                   |
| ------------------------- | ----------------------------- | --------------------------------------------------------- |
| `ctx.nav`                 | `.add(item)`                  | New entries in `AppShell` sidebar                         |
| `ctx.topbar`              | `.add(node)`                  | Items in the topbar (eg notifications bell, command menu) |
| `ctx.dashboard.tiles`     | `.add({ id, render })`        | Extra cards on the dashboard grid                         |
| `ctx.users.columns`       | `.add(col)`                   | Extra columns on the users table                          |
| `ctx.users.toolbar`       | `.add(node)`                  | Extra controls above the users table                      |
| `ctx.userDetail.sections` | `.add({ id, title, render })` | Extra sections on the user detail page                    |
| `ctx.userDetail.actions`  | `.add(node)`                  | Extra buttons next to "Edit"                              |
| `ctx.games.columns`       | `.add(col)`                   | Extra columns on the games table                          |
| `ctx.routes`              | `.add({ path, element })`     | New admin routes the consumer surfaces as Next pages      |

This list is intentionally small. Adding a slot is cheap; over-designing them up front is not. New slots get added when a real consumer needs one.

### Slot contract guarantees

- Order of registration determines render order. Plugins can pass `{ order: number }` to bias position.
- A slot consumer (the page) MUST handle an empty array gracefully. Pages render their defaults first; slot contributions append.
- Slot items keyed by `id` (where applicable) MUST be unique per plugin. Duplicate ids across plugins are an error at registration time.
- The registry is **immutable** after `UIPluginProvider` mounts. No runtime add/remove. If a feature needs to toggle, that's a conditional inside the rendered node.

## Type-safety

`defineUIPlugin` is typed; the `ctx` object is generated from the slot taxonomy. Adding a slot requires:

1. Extending the `UIPluginContext` interface in `@oss/react-sdk/src/ui-plugin/context.ts`.
2. Adding the corresponding `useXxx()` hook for pages to read from.
3. Calling that hook from the relevant page.

No code generation; pure TS types.

## Routes are special

`ctx.routes.add({ path, element })` only **registers metadata**. Next.js's filesystem router cannot accept routes from a function call. Consumers see a list of `RegisteredRoute[]` via `useRegisteredRoutes()` and are expected to create matching route files in their `app/` directory:

```tsx
// consumer's app/admin/(authed)/vip/page.tsx
import { renderRegisteredRoute } from '@oss/react-sdk';
export default function Page() {
  return renderRegisteredRoute('/admin/vip');
}
```

This keeps Next App Router happy without giving up the registry. The `renderRegisteredRoute` helper looks up the plugin-registered `element` for the path.

If this becomes painful (consumers having to write shims for every plugin route), we revisit by emitting Next route files at build time via a small codegen step - not before.

## Server / client boundary

`defineUIPlugin` is pure data + JSX. No server APIs. Plugins ship as ESM modules consumed by the consumer's Next app, compiled into the client bundle.

The server-side `definePlugin` (ADR-0002) is unchanged. A feature like vip-tiers becomes:

```
consumer/plugins/vip-tiers/
├── plugin.ts          # server (definePlugin) - existing
├── ui.tsx             # client (defineUIPlugin) - NEW
└── prisma.partial.prisma
```

The consumer's `extensions.config.ts` references both; `apps/api/main.ts` loads `plugin.ts`, `apps/web/app/providers.tsx` loads `ui.tsx`. No cross-talk.

## Consequences

**Positive:**

- Plugins extend the admin without forking. The promise of "extend without changing @oss/react-sdk" becomes real.
- Slots are small and explicit. No magic component scanning.
- TypeScript catches missing slot args; no runtime stringly-typed registry.
- Mirrors the existing API plugin pattern. One mental model for contributors.

**Negative / trade-offs:**

- Slot taxonomy needs governance. Adding too many slots makes pages a soup of injection points. Counter: every new slot must be backed by a real use case.
- `ctx.routes` requires consumers to write Next route shims. Acceptable for now.
- A plugin that wants to _replace_ a page (not just extend) needs a different mechanism. v1 is extension-only. If replacement comes up, add `ctx.users.replacePage(<MyUsersPage/>)` etc. - deferred.
- All UI plugins ship in the client bundle. Large plugins inflate the bundle even on routes that don't render their slots. If this becomes an issue, lazy-load via `React.lazy` inside the plugin's render functions.

## Naming

`defineUIPlugin` not `definePlugin` to avoid confusion with the server-side host. The `id` field is the same string used by the server plugin so logs/traces line up.

## Alternatives rejected

- **Shared `definePlugin` for both server and client**: forces context to span Nest + browser. Worst-of-both.
- **DOM scanning / portal-based injection**: brittle, untyped, magic.
- **Server-driven UI manifests** (server sends a JSON describing the admin layout): consumers can't ship custom React components without complex serialization.
- **Module federation**: heavy runtime, deployment complexity, debugging pain. Not yet warranted.
