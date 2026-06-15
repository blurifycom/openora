# ADR-0005: Backoffice ships as headless page components

**Date**: 2026-05-20
**Status**: Superseded (2026-06-10)

> **Superseded (2026-06-10):** All reference frontend apps (`apps/backoffice`, `apps/web`) and the associated UI packages (`@oss/react-sdk`, `@oss/backoffice-ui`, the pages layer) were removed. The platform is now headless backend only. The admin experience (pages, components, theming) now lives entirely in the consumer repo. This ADR is preserved as historical record of the architectural exploration.

## Context

The OSS repo includes `apps/backoffice` (Vite + TanStack Router admin SPA). Downstream consumers want the same admin experience inside their own app, with their own routing, navigation, theming, and potential per-tenant customization.

Three paths were considered:

1. **Standalone admin app**: ship `apps/backoffice` as a Docker image. Consumers point at the same admin app, configured by env. Rigid: can't add consumer-specific pages without forking. Doesn't match the plugin-host philosophy used elsewhere.

2. **Codegen / scaffold once**: a `/scaffold-backoffice` slash command stamps the routes into the consumer. Drifts the moment OSS evolves; needs migration scripts on every change.

3. **Headless page components**: extract shell + page bodies into a package; consumer mounts them in its own `app/` directory. Same pattern as Refine.dev, react-admin, AdminJS.

Prior art reviewed:

- **Refine.dev**: headless React admin, dataProvider + authProvider injection. Has been able to ship one admin lib to thousands of consumers.
- **react-admin**: same shape (`<Admin>`, `<Resource>`, `<Datagrid>`).
- **Saleor Dashboard / Strapi admin**: opposite pattern (standalone app). Painful to embed; consumers fork.

The "headless components" pattern is the dominant one for "one admin embedded in many apps."

## Decision

Extract the OSS backoffice into `@oss/backoffice-ui`:

- **What ships**: shell components (`AppShell`, `AuthGuard`, `StatCard`), page bodies (`LoginPage`, `DashboardPage`, `UsersListPage`, `UserDetailPage`, `GamesPage`), a UI-adapter context (`UIProvider`, `useUI`), and a theme system (`ThemeProvider`, `Theme`, presets).
- **What the consumer owns**: the Next App Router files. Each route file is a 4-line shim that renders a page component. Consumer routing prefix, nav config, brand, and theme are all props.
- **Visual layer**: a single `styles.css` driven by `--bo-*` CSS custom properties. Override via `ThemeProvider` (which emits inline `style="--bo-*: ..."` on a wrapping div). Per-tenant theming reduces to fetching a `Partial<Theme>` from the API.
- **Types**: page components consume `z.infer<typeof Schema>` from `@oss/orpc-contract`. No local type duplication.

`apps/backoffice` in this repo is itself the first consumer - it imports from `@oss/backoffice-ui`. A consumer's `apps/web/app/admin/` is the second.

## Consequences

**Positive:**

- One admin codebase, many consumers. New consumers add the package as a dep, write route shims, ship.
- Per-tenant theming is a single context boundary. No build step.
- Pages stay in sync with the API contract via `z.infer`.
- Adapter pattern preserved: consumers can still swap the UI library (Material UI, Radix, ...) via `UIProvider`.

**Negative / trade-offs:**

- Consumers must keep `app/` route files in sync with what the package exposes. Adding a new page requires both a package change and a consumer change.
- Cross-workspace `link:` (used during dev) creates a known dedup problem for React-context singletons (`react`, `react-query`). Solved by `next.config.ts` `resolveAlias` in each consumer pointing those three packages at a single physical path. Painful, but isolated to one config file.
- Server-side data prefetching (RSC + TanStack Query hydration) is not implemented yet because session auth is cookie-based and would need cookie forwarding plumbing. Pages stay client-side for now. Worth revisiting once SSR auth is wired.

## Implementation

- Package: `packages/ui/backoffice/` (`@oss/backoffice-ui`).
- Adapter contracts already in place: `@oss/ui-provider-contract`, `@oss/ui-provider-daisyui` (ADR-0003).
- Consumer wiring docs: `packages/ui/backoffice/AGENTS.md`.
- Cross-workspace dedup setup: the consumer's `apps/web/next.config.ts` (alias for `react`, `react-dom`, `@tanstack/react-query` to single physical paths).

## When to fork instead

If a consumer needs a fundamentally different admin (different IA, different mental model, different feature set), they fork - that's a feature, not a bug. The package is for consumers that want the OSS admin with their branding and a few page additions, not for consumers that want a different admin entirely.

## Alternatives rejected

- **Module Federation / micro-frontend**: heavy runtime, version-skew nightmares, hard to debug. Worth it only when the admin is owned by a different team than the consumer app.
- **iframe embed**: cross-frame messaging burden, broken focus management, no per-page theming.
- **Naked monorepo deep-import**: importing `apps/backoffice` route files from another Next app doesn't work - Next's filesystem router doesn't traverse external `app/` dirs. You'd be re-extracting to a lib anyway.
