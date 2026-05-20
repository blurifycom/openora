# casino-aggregator module

Provides a single adapter port for casino game aggregators (Softswiss, Slotegrator, etc). Ships the port interface and a mock provider. Aggregators sync game catalogs and handle callback webhooks.

## What this module does

- `POST /casino-aggregator/sync` - admin-triggered game catalog sync via the `AggregatorProvider` port.
- `GET  /casino-aggregator/providers` - list configured aggregator providers with game counts.
- `POST /casino-aggregator/callback` - receive and dispatch webhook callbacks from providers.

## Extension points

- **Add a real aggregator adapter**: implement `AggregatorProvider` (from `service/ports.ts`) in a new package under `packages/modules/casino-aggregator/adapters/<vendor>/`. Register it as an injectable with token `AGGREGATOR_PROVIDER`.
- **Subscribe to sync events**: listen to `aggregator.sync.completed` on the EventBus.
- **Subscribe to callback events**: listen to `aggregator.callback.received` on the EventBus.

## Ports

| Port symbol           | Interface            | Purpose                                                 |
| --------------------- | -------------------- | ------------------------------------------------------- |
| `AGGREGATOR_PROVIDER` | `AggregatorProvider` | Vendor adapter for game catalog sync + webhook handling |

`AggregatorProvider` is `@Optional()` - if not bound, `syncGames` is a no-op.

## Prisma tables

`AggregatorProvider` - stores per-tenant provider config (name, slug, isActive, JSON config).

Sync writes into the `Game` table owned by the `gaming` module (shared Prisma schema).

## Do

- Inject `AGGREGATOR_PROVIDER` as `@Optional()` so the module boots without an adapter bound.
- Emit `aggregator.sync.completed` and `aggregator.callback.received` after each operation.
- Return ISO strings for all dates.
- Throw domain errors (`AggregatorProviderNotFoundError`) from services, map to oRPC errors in the controller.

## Don't

- Don't call vendor HTTP APIs inline - put them behind `AggregatorProvider`.
- Don't write to the `Game` table from outside this module; use events instead.
- Don't import from other modules directly.
- Don't edit `infra/prisma/schema.prisma` by hand - edit `prisma.partial.prisma` and run `pnpm regen`.

## Sample diff - registering a vendor adapter

```typescript
// packages/modules/casino-aggregator/adapters/softswiss/index.ts
import { AGGREGATOR_PROVIDER } from '@oss/module-casino-aggregator';

export const softswissProvider = {
  provide: AGGREGATOR_PROVIDER,
  useClass: SoftswissAdapter,
};

// In your plugin.ts:
ctx.providers.add(softswissProvider);
```
