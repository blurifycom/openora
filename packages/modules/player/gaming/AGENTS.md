# Gaming Module - AGENTS.md

## What this module does

Game Integration Layer. Manages game catalog (`game` table), player game sessions
(`gameRound` table), and provides an adapter pattern so any game provider
can be swapped in without touching business logic. Both tables are defined as Drizzle
`pgTable` defs in `src/schema/index.ts` (money columns `betAmount` / `winAmount` are
`decimal(...)` - strings in TS).

OSS ships a `MockGameAdapter`. Real providers implement the `GameAdapter`
interface and are injected via the `GAME_ADAPTER` symbol.

Routes:

- `GET /gaming/games` - list active games (optionally filtered by tenantId via x-tenant-id header)
- `GET /gaming/games/{id}` - get single game or 404
- `POST /gaming/rounds/start` - create a round, call provider.launchGame(), emit gaming.round.started
- `POST /gaming/rounds/{roundId}/end` - complete a round, emit gaming.round.ended
- `GET /gaming/rounds` - last 50 rounds for the requesting user (x-user-id header)

## Extension points

- **GameAdapter interface** (`@oss/adapters`): implement the `GameAdapter` interface to swap in a
  real provider. Override the `GAME_ADAPTER` binding in the plugin or a downstream overlay.
- **Events**: `gaming.round.started` and `gaming.round.ended` are emitted via EventBus.
  Subscribe in another module without importing gaming directly.
- **Routes**: add via `/scaffold-route gaming <method> <path>`
- **UI slots**: none currently

## Ports

| Symbol          | Interface      | Default impl               |
| --------------- | -------------- | -------------------------- |
| `GAME_ADAPTER` | `GameAdapter` | `MockGameAdapter` (no-op) |

To provide a real adapter:

1. Create `packages/modules/gaming/src/adapters/<vendor>/<vendor>-game-provider.ts` implementing `GameAdapter`.
2. Register it in your overlay plugin: `ctx.provide(GAME_ADAPTER, () => new RealProvider())`.

## Events emitted

| Event                  | Payload                                 |
| ---------------------- | --------------------------------------- |
| `gaming.round.started` | `{ roundId, gameId, userId, currency }` |
| `gaming.round.ended`   | `{ roundId, userId }`                   |

## Do

- Implement `GameAdapter` in an adapter under `adapters/<vendor>/`, never inline in the service.
- Throw domain errors (`GameNotFoundError`, `GameRoundNotFoundError`) from services.
- Query the `game` / `gameRound` tables via `DrizzleService` (inject `DrizzleService` from `@oss/db`; tables from `../schema/index.js`, operators from `drizzle-orm`) - no casts needed.
- Run `pnpm regen` after editing `src/schema/index.ts` to generate the migration.

## Don't

- Import from other modules directly - emit events instead.
- Throw framework HTTP errors or `ORPCError` from services - catch domain errors in the router.
- Edit the generated migrations under `packages/platform/db/` by hand - the source of truth is `src/schema/index.ts`.
- Add inline Zod schemas in handlers - all schemas live in `src/schemas/` or `@oss/orpc-contract/gaming`.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=gaming` shows the new/changed route(s) (e.g. `gaming.startRound`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- If you changed the `GameAdapter` contract, `pnpm regen` then check `docs/CATALOG.md` shows the `GAME_ADAPTER` seam still wired.
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
