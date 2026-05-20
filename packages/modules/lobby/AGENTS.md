# Lobby Module - AGENTS.md

## What this module does

Provides game navigation and discovery: categorized game feeds, featured slots, and full-text game search. The lobby manages its own categorization and featured slot data, but reads `Game` records directly from the shared DB (cross-module code imports are forbidden; cross-module DB reads are fine since they share one Postgres instance).

Routes:

- `GET /lobby/categories` - list all lobby categories with game counts
- `GET /lobby/categories/{slug}` - get one category with its game list
- `GET /lobby/featured` - active featured slots with game name and thumbnail
- `GET /lobby/search?q=` - search games by name (case-insensitive)

## Extension points

- Routes: `src/router/index.ts` - add oRPC procedures and map to service methods
- Service: `src/service/lobby.service.ts` - add new query/mutation methods here
- Schema: `prisma.partial.prisma` - add tables, then run `pnpm regen`
- Events: emit via `this.events.emit(...)` for cross-module side-effects
- UI slots: none defined yet

## Ports

None - the lobby has no external third-party integrations. If a CMS-driven lobby feed is needed in future, define an interface in `src/service/ports.ts` and implement an adapter under `src/adapters/<vendor>/`.

## Do

- Add business logic to `service/lobby.service.ts` as plain async methods
- Throw domain errors (`LobbyCategoryNotFoundError`) from service; map to oRPC errors in the router
- Use `(this.prisma as unknown as Record<...>)` pattern for models not yet in generated types
- Add new routes via `/scaffold-route lobby <method> <path>`
- Keep `tenantId` on every new Prisma model

## Don't

- Import from other modules (eg `@oss/module-gaming`) - query the DB directly instead
- Throw `HttpException` or `ORPCError` from the service - only from the router handler
- Edit `infra/prisma/schema.prisma` directly - edit `prisma.partial.prisma` and run `pnpm regen`
- Add inline Zod schemas in router or service - all schemas live in `src/schemas/` or the contract
- Use `any` - use `unknown` with explicit type assertions and narrowing
