# ADR-0008: Player vs admin split lives at the SDK/app layer, not in the wire contract

**Date**: 2026-05-22
**Status**: Accepted

## Context

The platform exposes one flat oRPC contract (`wallet.*`, `gaming.*`, `backoffice.*`, ...). We wanted a clear separation between the **player** surface (a gambler: balance, bet, lobby, chat) and the **admin/backoffice** surface (operator staff: user management, stats, CMS, geo rules), down to two reference apps.

Two problems were intertwined:

1. **Security gap.** Only the `player` module enforced an admin check (`assertAdmin`). 16 admin-capable routes were completely unguarded: all of `backoffice.*`, the `cms` write routes, `compliance.addGeoRule`/`listGeoRules`, `igaming-aggregator.sync`/`listProviders`, and the `localization` write routes.
2. **How to express the player/admin division.** The tempting option was to nest the contract into `player.*` and `admin.*` namespaces.

A route-level audit showed the namespace re-prefix would touch ~60 procedures across 13 contract files, force 4 straddling modules (`cms`, `compliance`, `localization`, `igaming-aggregator`) to be split in two, and ripple to the typed client, every react-sdk page, the consumer app + plugins, the MCP `query-openapi` expectations, the emitted OpenAPI, and the docs. It is a one-way, high-churn change.

## Decision

1. **Keep flat wire paths.** Do **not** re-prefix routes into `player.*`/`admin.*`. `client.wallet.getBalance()` and `client.backoffice.listUsers()` stay as they are.
2. **Express the split where it is navigated, not on the wire:**
   - `@openora/react-sdk` pages are grouped `src/pages/admin/` and `src/pages/player/`.
   - Two reference apps consume the respective surfaces: `apps/backoffice` (admin) and `apps/web` (player).
3. **Enforce admin access with one shared guard.** `AdminGuard` (in `@openora/auth`, seeded into the composition container by `createApp`) resolves the better-auth session and asserts `role === 'admin'`, throwing `ORPCError` UNAUTHORIZED/FORBIDDEN. Every admin route calls `await adminGuard.assert(context)` as its first line. This is the single enforcement point; modules never re-implement the role check.

## Consequences

**Positive:**

- The 16 unguarded admin routes are now closed - the security win is delivered without a contract rewrite.
- Near-zero blast radius: the consumer and every existing call site keep working unchanged.
- The player/admin distinction is obvious exactly where a developer looks for it - the SDK page folders and the two apps.
- One auditable admin gate (`AdminGuard`), not a per-module reimplementation.

**Negative / trade-offs:**

- The wire path does not self-document player vs admin (`wallet.getBalance`, not `player.wallet.getBalance`). The distinction is a convention enforced by the guard + the SDK/app grouping, not by the URL shape.
- A future contributor might re-propose the namespace re-prefix; this ADR records that it was a deliberate rejection on blast-radius grounds, not an oversight.

**Neutral:**

- `igaming-aggregator.callback` stays unguarded by design - it is a machine-to-machine webhook secured by signature/allowlist at the edge, not an admin session.
- If a future need (eg per-surface rate limits, separate OpenAPI docs) justifies the churn, the re-prefix can still be done later; nothing here forecloses it.
