# Chat Module - AGENTS.md

## What this module does

Provides global chat and room-based chat for the platform. Stores messages in Postgres via Drizzle (`chatRoom` / `chatMessage` `pgTable` defs in `src/schema/index.ts`). Exposes REST endpoints (via oRPC) for listing rooms, fetching message history, sending messages, and soft-deleting messages. Real-time delivery (SSE/WebSocket) is out of scope - this module is the storage and HTTP layer only.

## Extension points

- Ports: add interfaces to `@oss/adapters` when integrating moderation services or third-party chat providers
- Routes: `src/router/index.ts` - add new oRPC procedures via `/scaffold-route chat <method> <path>`
- Events emitted:
  - `chat.message.sent` - fired on every new message (room or global), payload: `{ messageId, roomId, userId }`
- UI slots: none yet

## Ports

None currently. Chat reads/writes the DB directly via `DrizzleService` (`@oss/db`). To add a moderation adapter:

1. Define an interface in `@oss/adapters`
2. Implement in `src/adapters/<vendor>/`
3. Inject via Nest DI token

## Do

- Add business logic to `service/chat.service.ts` as plain async methods
- Throw domain errors (`ChatRoomNotFoundError`, etc.) from the service - never `ORPCError` or `HttpException`
- Map domain errors to `ORPCError` in `router/index.ts`
- Add `pgTable` defs to `src/schema/index.ts`, then run `pnpm regen`
- Keep `tenantId` on every new multi-tenant `pgTable`
- Extract userId/username from `x-user-id` / `x-username` request headers

## Don't

- Import from other modules directly - use EventBus for cross-module communication
- Throw `HttpException` or `ORPCError` from services
- Edit the generated migrations under `packages/platform/db/` by hand - the source of truth is `src/schema/index.ts`
- Add inline Zod schemas in the router or service - all schemas live in `src/schemas/` or `@oss/orpc-contract/chat`
- Use `any` - use `unknown` + narrowing

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=chat` shows the new/changed route(s) (e.g. `chat.sendRoomMessage`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
