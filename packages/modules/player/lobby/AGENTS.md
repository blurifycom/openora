# Lobby Module - AGENTS.md

## What this module does

Provides game navigation and discovery: categorized game feeds, featured slots, and full-text game search. The lobby manages its own categorization and featured slot data, but reads `game` records from the `gaming` module via the schema subpath import `import { game } from '@oss/modules/player/gaming/schema'` (cross-module code/service imports are forbidden; reading another module's table via its schema subpath is the sanctioned pattern - they share one Postgres instance).

Routes:

- `GET /lobby/categories` - list all lobby categories with game counts
- `GET /lobby/categories/{slug}` - get one category with its game list
- `GET /lobby/featured` - active featured slots with game name and thumbnail
- `GET /lobby/search?q=` - search games by name (case-insensitive)

## Extension points

- Routes: `src/router/index.ts` - add oRPC procedures and map to service methods
- Service: `src/service/lobby.service.ts` - add new query/mutation methods here
- Schema: `src/schema/index.ts` - add `pgTable` defs, then run `pnpm regen`
- Events: emit via `this.events.emit(...)` for cross-module side-effects
- UI slots: none defined yet

## Ports

None - the lobby has no external third-party integrations. If a CMS-driven lobby feed is needed in future, define an interface in `@oss/adapters` and implement an adapter under `src/adapters/<vendor>/`.

## Do

- Add business logic to `service/lobby.service.ts` as plain async methods (inject `DrizzleService` from `@oss/db`; operators from `drizzle-orm`)
- Throw domain errors (`LobbyCategoryNotFoundError`) from service; map to oRPC errors in the router
- Read another module's table by importing it via the schema subpath (eg `@oss/modules/player/gaming/schema`) - no casts needed
- Add new routes via `/scaffold-route lobby <method> <path>`
- Keep `tenantId` on every new multi-tenant `pgTable`

## Don't

- Import another module's service/runtime code (eg `@oss/modules/player/gaming`) - read its table via the schema subpath, or use events
- Throw framework HTTP errors or `ORPCError` from the service - only from the router handler
- Edit the generated migrations under `packages/platform/db/` by hand - edit `src/schema/index.ts` and run `pnpm regen`
- Add inline Zod schemas in router or service - all schemas live in `src/schemas/` or the contract
- Use `any` - use `unknown` with explicit type assertions and narrowing

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=lobby` shows the new/changed route(s) (e.g. `lobby.search`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
