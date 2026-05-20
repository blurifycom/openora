# compliance Module - AGENTS.md

## What this module does

Responsible gambling and geo-compliance.

- Tracks deposit, wagering, and loss limits per user (daily / weekly / monthly).
- Manages geo-blocking rules by country code (allow / block).
- Provides a geo-check endpoint the frontend calls on load to determine whether the player's country is permitted.

## Extension points

- **GeoIpPort** (`src/service/ports.ts`) - inject a real IP-geolocation adapter by providing `GEO_IP_PORT` token. Without it the module defaults all countries to `allowed: true`.
- Routes: `src/router/index.ts` - add new procedures by extending `complianceContract` in `packages/contracts/orpc-contract/src/compliance.ts` first.
- Events emitted: `compliance.limit.upserted`, `compliance.limit.removed` - subscribe in other modules via `EventBus`.
- UI slots: `LimitsPanel` (headless DataTable, swap via UIProvider).

## Ports

| Symbol        | Interface   | Purpose              |
| ------------- | ----------- | -------------------- |
| `GEO_IP_PORT` | `GeoIpPort` | IP-to-country lookup |

Implement adapters under `packages/modules/compliance/adapters/<vendor>/` and register via `ctx.providers.add({ provide: GEO_IP_PORT, useClass: MyAdapter })` in an overlay plugin.

## Do

- Add new limit types by extending the `type` enum in `packages/contracts/orpc-contract/src/compliance.ts` and the `UpsertLimitInputSchema` in `src/schemas/index.ts`.
- Provide a real `GeoIpPort` implementation via an overlay plugin to enable actual geo-blocking.
- Keep domain errors in `compliance.service.ts`; map them to `ORPCError` in the router only.
- Add new tables to `prisma.partial.prisma`, then run `pnpm regen`.

## Don't

- Import from other modules directly - use EventBus for cross-module communication.
- Throw `ORPCError` or `HttpException` from service methods.
- Edit `infra/prisma/schema.prisma` directly.
- Add inline Zod schemas in controllers or services - all schemas live in `src/schemas/` or `@oss/orpc-contract`.
