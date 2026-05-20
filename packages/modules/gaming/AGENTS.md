# Gaming Module - AGENTS.md

## What this module does

Game Integration Layer. Manages game catalog (Game model), player game sessions
(GameRound model), and provides a port-based adapter pattern so any game provider
can be swapped in without touching business logic.

OSS ships a `MockGameProvider` adapter. Real providers implement the `GameProvider`
port and are injected via `GAME_PROVIDER` symbol.

Routes:

- `GET /gaming/games` - list active games (optionally filtered by tenantId via x-tenant-id header)
- `GET /gaming/games/{id}` - get single game or 404
- `POST /gaming/rounds/start` - create a round, call provider.launchGame(), emit gaming.round.started
- `POST /gaming/rounds/{roundId}/end` - complete a round, emit gaming.round.ended
- `GET /gaming/rounds` - last 50 rounds for the requesting user (x-user-id header)

## Extension points

- **GameProvider port** (`src/service/ports.ts`): implement `GameProvider` interface to swap in a
  real provider. Override `GAME_PROVIDER` binding in the plugin or a downstream overlay.
- **Events**: `gaming.round.started` and `gaming.round.ended` are emitted via EventBus.
  Subscribe in another module without importing gaming directly.
- **Routes**: add via `/scaffold-route gaming <method> <path>`
- **UI slots**: none currently

## Ports

| Symbol          | Interface      | Default impl               |
| --------------- | -------------- | -------------------------- |
| `GAME_PROVIDER` | `GameProvider` | `MockGameProvider` (no-op) |

To provide a real adapter:

1. Create `packages/modules/gaming/src/adapters/<vendor>/<vendor>-game-provider.ts` implementing `GameProvider`.
2. Register it in your overlay plugin: `ctx.providers.add({ provide: GAME_PROVIDER, useClass: RealProvider })`.

## Events emitted

| Event                  | Payload                                 |
| ---------------------- | --------------------------------------- |
| `gaming.round.started` | `{ roundId, gameId, userId, currency }` |
| `gaming.round.ended`   | `{ roundId, userId }`                   |

## Do

- Implement `GameProvider` in an adapter under `adapters/<vendor>/`, never inline in the service.
- Throw domain errors (`GameNotFoundError`, `GameRoundNotFoundError`) from services.
- Keep Prisma queries behind `(this.prisma as any).game` until `pnpm regen` generates the Game/GameRound models.
- Run `pnpm regen` after editing `prisma.partial.prisma` to regenerate the merged schema.

## Don't

- Import from other modules directly - emit events instead.
- Throw `HttpException` or `ORPCError` from services - catch domain errors in the router.
- Edit `infra/prisma/schema.prisma` directly - it's generated.
- Add inline Zod schemas in handlers - all schemas live in `src/schemas/` or `@oss/orpc-contract/gaming`.
