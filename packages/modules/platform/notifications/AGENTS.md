# notifications module

In-app notification inbox. Other modules create notifications by emitting events that a wired handler reacts to (never by importing this module). Users fetch and mark notifications read via the HTTP API. Email delivery is decoupled behind `NotificationDeliveryAdapter`.

## What this module does

- Stores per-user notifications in the `notification` table.
- Exposes three routes: list (GET /notifications), mark one read (POST /notifications/{id}/read), mark all read (POST /notifications/read-all).
- Emits `notifications.created` after each insert.
- Listens for `identity.user.registered` (welcome notification hookup point).

## Extension points

| Point                            | How                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Email delivery                   | Implement `NotificationDeliveryAdapter`, bind via `ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MyAdapter())`                        |
| Push/SMS delivery                | Add a new adapter interface in `@oss/adapters`, create adapter in `adapters/<vendor>/`                                                       |
| Welcome notification on register | Wire the `identity.user.registered` handler to call `NotificationsService.create()` from an event handler or a worker job |
| Additional notification types    | Add enum/constant in `schemas/index.ts`, no schema migration needed (type is free-form string)                                         |
| Custom list filters              | Extend the `list` route input schema with filter fields, propagate to `listForUser()`                                                  |

## Ports

- `NotificationDeliveryAdapter` (`@oss/adapters`) - `sendEmail(to, subject, body)`. No default implementation; stub it or provide an adapter (eg `adapters/sendgrid/`).

## Do

- Call `NotificationsService.create()` from event handlers or worker jobs to fan out to users.
- Throw domain errors (`NotificationNotFoundError`, `NotificationOwnershipError`) from the service; map them to `ORPCError` in the handler.
- Add new routes via `/scaffold-route notifications <method> <path>`.
- Keep `tenantId` on any new multi-tenant models you add.

## Don't

- Import from other modules directly - emit events and let consumers react.
- Throw framework HTTP errors from service methods - throw domain errors and map them to `ORPCError` in the handler.
- Edit the generated migrations under `packages/platform/db/` by hand - edit the `pgTable` defs in `src/schema/index.ts` and run `pnpm regen`.
- Define Zod schemas inline in handlers - add them to `src/schemas/index.ts`.
- Assume `ctx.events.on(...)` handlers fire yet - they are collected at `register()` but not yet wired to the bus (ADR-0010 backlog); for the welcome notification use a worker or a post-boot hook for now.

## Done when

- `pnpm verify` passes (typecheck + lint + boundaries + module-shape + tests).
- `list-routes module=notifications` shows the new/changed route(s) (e.g. `notifications.markRead`).
- No `boundaries/dependencies` lint errors (no cross-module code imports; read other modules' tables only via the `@oss/modules/<group>/<name>/schema` subpath).
- New tables: added to `src/schema/index.ts`, `pnpm regen` run, migration committed.
