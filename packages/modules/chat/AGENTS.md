# Chat Module - AGENTS.md

## What this module does

Provides global chat and room-based chat for the platform. Stores messages in Postgres via Prisma. Exposes REST endpoints (via oRPC) for listing rooms, fetching message history, sending messages, and soft-deleting messages. Real-time delivery (SSE/WebSocket) is out of scope - this module is the storage and HTTP layer only.

## Extension points

- Ports: `src/service/ports.ts` - add interfaces here when integrating moderation services or third-party chat providers
- Routes: `src/router/index.ts` - add new oRPC procedures via `/scaffold-route chat <method> <path>`
- Events emitted:
  - `chat.message.sent` - fired on every new message (room or global), payload: `{ messageId, roomId, userId }`
- UI slots: none yet

## Ports

None currently. Chat uses direct Prisma access. To add a moderation adapter:

1. Define an interface in `src/service/ports.ts`
2. Implement in `src/adapters/<vendor>/`
3. Inject via Nest DI token

## Do

- Add business logic to `service/chat.service.ts` as plain async methods
- Throw domain errors (`ChatRoomNotFoundError`, etc.) from the service - never `ORPCError` or `HttpException`
- Map domain errors to `ORPCError` in `router/index.ts`
- Add tables to `prisma.partial.prisma`, then run `pnpm regen`
- Keep `tenantId` on every new Prisma model
- Extract userId/username from `x-user-id` / `x-username` request headers

## Don't

- Import from other modules directly - use EventBus for cross-module communication
- Throw `HttpException` or `ORPCError` from services
- Edit `infra/prisma/schema.prisma` directly
- Add inline Zod schemas in the router or service - all schemas live in `src/schemas/` or `@oss/orpc-contract/chat`
- Use `any` - use `unknown` + narrowing
