# Chat Module - AGENTS.md

## What this module does

Provides global chat and room-based chat for the platform. Stores messages in Postgres via Drizzle (`chatRoom` / `chatMessage` `pgTable` defs in `src/schema/index.ts`). Exposes REST endpoints (via oRPC) for listing rooms, fetching message history, sending messages, and soft-deleting messages. Delivers messages live over the `REALTIME_TRANSPORT` seam: `sendRoomMessage`/`sendGlobalMessage` persist then `publish` to a `chat:room:<id>` / `chat:global` channel, and `streamMessages` exposes an `eventIterator` route served as SSE (consume client-side with `useChatStream`). The transport is first-party in-process by default and swappable to a managed vendor (Ably/GetStream) by rebinding the token - see ADR-0007 and ADR-0014.

## Extension points

- Ports: add interfaces to `@oss/adapters` when integrating moderation services or third-party chat providers
- Routes: `src/router/index.ts` - add new oRPC procedures via `/scaffold-route chat <method> <path>`
- Events emitted:
  - `chat.message.sent` - fired on every new message (room or global), payload: `{ messageId, roomId, userId }`
- Realtime: `subscribeMessages(roomId, listener)` delegates to `REALTIME_TRANSPORT`; the `streamMessages` route bridges it to SSE. Swap transport by rebinding `REALTIME_TRANSPORT` in an overlay.
- UI: the platform is headless - the chat page lives in the consumer frontend; the client consumes this module's SSE via `useChatStream` (`@oss/react`).

## Ports

None currently. Chat reads/writes the DB directly via `DrizzleService` (`@oss/db`). To add a moderation adapter:

1. Define an interface in `@oss/adapters`
2. Implement in `src/adapters/<vendor>/`
3. Resolve via its token from the container (passed into the router factory by plugin.ts)

## Do

- Add business logic to `service/chat.service.ts` as plain async methods
- Throw domain errors (`ChatRoomNotFoundError`, etc.) from the service - never `ORPCError` or framework HTTP errors
- Map domain errors to `ORPCError` in `router/index.ts`
- Add `pgTable` defs to `src/schema/index.ts`, then run `pnpm regen`
- Keep `tenantId` on every new multi-tenant `pgTable`
- Resolve the caller's userId from the verified session (`getUserId`, ADR-0019); the cosmetic display `x-username` header is read separately and is never an auth/tenant trust path

## Don't

- Import from other add-ons directly - use EventBus for cross-add-on communication
- Throw framework HTTP errors or `ORPCError` from services
- Edit the generated migrations under `packages/platform/db/` by hand - the source of truth is `src/schema/index.ts`
- Add inline Zod schemas in the router or service - all schemas live in `src/schemas/` or `@oss/orpc-contract/chat`
- Use `any` - use `unknown` + narrowing

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=chat` shows the new/changed route(s) (e.g. `chat.sendRoomMessage`).
- No `boundaries/dependencies` lint errors (no cross-add-on code imports; read other add-ons' tables only via the `@oss-addons/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
