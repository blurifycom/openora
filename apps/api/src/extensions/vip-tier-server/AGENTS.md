# vip-tier-server (overlay)

Reference overlay plugin proving the four extension axes work end-to-end. Paired
with the client UI plugin `@oss/example-vip-tier` (shared id stem `vip-tier`).

## What this overlay does

| Axis | Where | What |
|---|---|---|
| `ctx.provide` | `plugin.ts` | Binds `VIP_TIER_SERVICE` to an in-memory `VipTierService` |
| `ctx.routers.add` | `plugin.ts` | Adds `GET /vip-tier/{playerId}` under the `vipTier` namespace |
| `ctx.events.on` | `plugin.ts` | Subscribes to `wallet.deposit.completed` and accrues VIP points |
| `ctx.mcp.tool` | n/a | Not demonstrated here - see other modules for the pattern |

## Why an overlay (not a module)

This is feature behavior that does not belong to any core domain, lives in
`apps/api/src/extensions/` rather than `packages/modules/`, and is registered
LAST in `extensions.config.ts` so its event handlers see deposits emitted by
the wallet module.

## Boundaries

- No imports from any other `apps/api/src/extensions/*` folder.
- No edits to `packages/modules/**` to make this work.
- Uses only `@oss/*` packages from the workspace.

## Dev loop

`pnpm dev` starts the api with this overlay loaded. Hit
`GET http://localhost:3001/vip-tier/{playerId}` to read a player's tier; the
in-memory store starts empty and accrues on each `wallet.deposit.completed`
event.

In production an operator would replace the in-memory service with a real
persistence layer (Drizzle table in this folder's `src/schema/index.ts` + a
DB-backed service), but that is intentionally out of scope for a reference.
