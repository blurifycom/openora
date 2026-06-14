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

- `GET /gaming/games` - list active games (filtered by the caller's verified tenant when authenticated; public list otherwise)
- `GET /gaming/games/{id}` - get single game or 404
- `POST /gaming/rounds/start` - create a round, call provider.launchGame(), emit gaming.round.started
- `POST /gaming/rounds/{roundId}/end` - complete a round, emit gaming.round.ended
- `GET /gaming/rounds` - last 50 rounds for the verified caller (getUserId)

## Pre-auth tenant (default/public tenant)

`GET /gaming/games` serves two paths (ADR-0018/0019):

- **Authenticated** caller -> `listGames(verifiedTenantId)` on the RLS-enforced `this.drizzle.db`. The tenant comes from the verified session (`getTenantId(context)`), never a header.
- **Anonymous** caller -> `listPublicGames()`. A pre-auth request has no tenant GUC, so the RLS app role would fail-closed to zero rows. The public catalog is read-only and the tenant is the server-side `DEFAULT_TENANT_ID` constant (`@oss/shared-schemas`, never client input), so this path reads the BYPASSRLS `adminDb` with an EXPLICIT `isActive AND tenantId = DEFAULT_TENANT_ID` filter. This is the single sanctioned pre-auth read.

Multi-brand operators that need a real tenant before auth resolve it from host/brand for pre-auth requests - a documented extension seam, not built here. Do NOT set a default GUC for anonymous requests in the middleware (that would make protected routes return default-tenant data instead of failing closed).

## Extension points

- **GameAdapter interface** (`@oss/adapters`): implement the `GameAdapter` interface to swap in a
  real provider. Override the `GAME_ADAPTER` binding in the plugin or a downstream overlay.
- **Events**: `gaming.round.started` and `gaming.round.ended` are emitted via EventBus.
  Subscribe in another module without importing gaming directly.
- **Routes**: add via `/scaffold-route gaming <method> <path>`
- **UI slots**: none currently

## Ports

| Symbol         | Interface     | Default impl              |
| -------------- | ------------- | ------------------------- |
| `GAME_ADAPTER` | `GameAdapter` | `MockGameAdapter` (no-op) |

To provide a real adapter:

1. Create `packages/addons/gaming/src/adapters/<vendor>/<vendor>-game-provider.ts` implementing `GameAdapter`.
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

- Import from other add-ons directly - emit events instead.
- Throw framework HTTP errors or `ORPCError` from services - catch domain errors in the router.
- Edit the generated migrations under `packages/platform/db/` by hand - the source of truth is `src/schema/index.ts`.
- Add inline Zod schemas in handlers - all schemas live in `src/schemas/` or `@oss/orpc-contract/gaming`.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=gaming` shows the new/changed route(s) (e.g. `gaming.startRound`).
- No `boundaries/dependencies` lint errors (no cross-add-on code imports; read other add-ons' tables only via the `@oss-addons/<name>/schema` subpath).
- If you changed the `GameAdapter` contract, `pnpm regen` then check `docs/catalog.json` shows the `GAME_ADAPTER` seam still wired.
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
