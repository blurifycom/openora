# compliance Module - AGENTS.md

## What this module does

Responsible gambling and geo-compliance.

- Tracks deposit, wagering, and loss limits per user (daily / weekly / monthly).
- Manages geo-blocking rules by country code (allow / block).
- Provides a geo-check endpoint the frontend calls on load to determine whether the player's country is permitted.

## Extension points

- **GeoIpAdapter** (`@oss/adapters`) - inject a real IP-geolocation adapter by providing the `GEO_IP_ADAPTER` token. Without it the module defaults all countries to `allowed: true`.
- Routes: `src/router/index.ts` - add new procedures by extending `complianceContract` in `packages/contracts/orpc-contract/src/compliance.ts` first.
- Events emitted: `compliance.limit.upserted`, `compliance.limit.removed` - subscribe in other modules via `EventBus`.
- UI slots: `LimitsPanel` (headless DataTable, swap via UIProvider).

## Ports

| Symbol        | Interface   | Purpose              |
| ------------- | ----------- | -------------------- |
| `GEO_IP_ADAPTER` | `GeoIpAdapter` | IP-to-country lookup |

Implement adapters under `packages/modules/platform/compliance/adapters/<vendor>/` and register via `ctx.provide(GEO_IP_ADAPTER, () => new MyAdapter())` in an overlay plugin.

## Do

- Add new limit types by extending the `type` enum in `packages/contracts/orpc-contract/src/compliance.ts` and the `UpsertLimitInputSchema` in `src/schemas/index.ts`.
- Provide a real `GeoIpAdapter` implementation via an overlay plugin to enable actual geo-blocking.
- Keep domain errors in `compliance.service.ts`; map them to `ORPCError` in the router only.
- Add or edit `pgTable` defs in `src/schema/index.ts` (`userLimit`, `geoRule`), then run `pnpm regen`.

## Don't

- Import from other modules directly - use EventBus for cross-module communication.
- Throw `ORPCError` or framework HTTP errors from service methods.
- Edit the generated migrations under `packages/platform/db/` by hand - the source of truth is `src/schema/index.ts`.
- Add inline Zod schemas in controllers or services - all schemas live in `src/schemas/` or `@oss/orpc-contract`.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=compliance` shows the new/changed route(s) (e.g. `compliance.upsertLimit`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
