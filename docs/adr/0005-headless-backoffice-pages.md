# ADR-0005: Backoffice ships as headless page components

**Date**: 2026-05-20
**Status**: Accepted (superseded in part - see Update below)

> **Update (2026-05-20)**: The original decision created a dedicated package
> `@oss/backoffice-ui` and kept `apps/backoffice` as the reference consumer.
> Shortly after, both were consolidated:
>
> - `@oss/backoffice-ui` and `@oss/client` were merged into `@oss/react-sdk`.
>   The pages, shell, theme, `UIProvider`, and typed oRPC client now all live
>   there. Rationale: the "data hooks vs UI components" split was artificial
>   when both ship together and both are React-only (cf. `@stripe/react-stripe-js`,
>   `@auth0/auth0-react`).
> - `apps/backoffice` moved to `packages/sdks/react-sdk/examples/backoffice`
>   (`@oss/example-backoffice`) - it's a reference/dev-sandbox, not a product app.
> - `@oss/design-system` was deleted (unused; tokens now live in `theme.tsx`).
> - Plugin-driven UI extension (the "extend without forking" gap this ADR's
>   monolithic pages left open) is addressed by ADR-0006.
>
> **Update (2026-05-22)**: The reference consumer apps moved back under `apps/`
> when the platform split into two surfaces: `apps/backoffice` (`@oss/backoffice`,
> admin) and `apps/web` (`@oss/web`, player). The react-sdk pages are now grouped
> as `src/pages/admin/` and `src/pages/player/`. The `examples/` dir was removed.
>
> Everywhere this ADR says `@oss/backoffice-ui`, read `@oss/react-sdk`.
> Everywhere it says `packages/ui/backoffice/`, read `packages/sdks/react-sdk/`.

## Context

The OSS repo includes `apps/backoffice` (Next.js admin). Downstream consumers like Consumer want the same admin experience inside their own Next.js app, with their own routing, navigation, theming, and potential per-tenant customization.

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

`apps/backoffice` in this repo is itself the first consumer - it imports from `@oss/backoffice-ui`. Consumer's `consumer/apps/web/app/admin/` is the second.

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
- Cross-workspace dedup setup: `consumer/apps/web/next.config.ts` (alias for `react`, `react-dom`, `@tanstack/react-query` to single physical paths).

## When to fork instead

If a consumer needs a fundamentally different admin (different IA, different mental model, different feature set), they fork - that's a feature, not a bug. The package is for consumers that want the OSS admin with their branding and a few page additions, not for consumers that want a different admin entirely.

## Alternatives rejected

- **Module Federation / micro-frontend**: heavy runtime, version-skew nightmares, hard to debug. Worth it only when the admin is owned by a different team than the consumer app.
- **iframe embed**: cross-frame messaging burden, broken focus management, no per-page theming.
- **Naked monorepo deep-import**: importing `apps/backoffice` route files from another Next app doesn't work - Next's filesystem router doesn't traverse external `app/` dirs. You'd be re-extracting to a lib anyway.
