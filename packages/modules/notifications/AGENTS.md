# notifications module

In-app notification inbox. Other modules create notifications by emitting events or calling `NotificationsService.create()` directly via Nest DI. Users fetch and mark notifications read via the HTTP API. Email delivery is decoupled behind `NotificationDeliveryPort`.

## What this module does

- Stores per-user notifications in the `notification` table.
- Exposes three routes: list (GET /notifications), mark one read (POST /notifications/{id}/read), mark all read (POST /notifications/read-all).
- Emits `notifications.created` after each insert.
- Listens for `identity.user.registered` (welcome notification hookup point).

## Extension points

| Point                            | How                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Email delivery                   | Implement `NotificationDeliveryPort`, provide via Nest DI with token `NOTIFICATION_DELIVERY_PORT`                                      |
| Push/SMS delivery                | Add new port interface in `service/ports.ts`, create adapter in `adapters/<vendor>/`                                                   |
| Welcome notification on register | In production wire the `identity.user.registered` handler to call `NotificationsService.create()` via the Nest app ref or a worker job |
| Additional notification types    | Add enum/constant in `schemas/index.ts`, no schema migration needed (type is free-form string)                                         |
| Custom list filters              | Extend the `list` route input schema with filter fields, propagate to `listForUser()`                                                  |

## Ports

- `NotificationDeliveryPort` (`src/service/ports.ts`) - `sendEmail(to, subject, body)`. No default implementation; stub it or provide an adapter (eg `adapters/sendgrid/`).

## Do

- Call `NotificationsService.create()` from event handlers or worker jobs to fan out to users.
- Throw domain errors (`NotificationNotFoundError`, `NotificationOwnershipError`) from the service; map them to `ORPCError` in the handler.
- Add new routes via `/scaffold-route notifications <method> <path>`.
- Keep `tenantId` on any new multi-tenant models you add.

## Don't

- Import from other modules directly - emit events and let consumers react.
- Throw `HttpException` from service methods.
- Edit `infra/prisma/schema.prisma` directly - edit `prisma.partial.prisma` and run `pnpm regen`.
- Define Zod schemas inline in handlers - add them to `src/schemas/index.ts`.
- Wire the welcome notification in `plugin.ts` `register()` - the Nest DI container is not ready at that point; use a worker or a post-boot hook.
