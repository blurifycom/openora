# localization module - AGENTS.md

DB-backed i18n. Operators load translation strings per locale. Frontend fetches translations by locale + namespace (e.g. "common", "lobby"). Supports admin CRUD.

## Routes

| Method | Path                                            | Handler                                  |
| ------ | ----------------------------------------------- | ---------------------------------------- |
| GET    | /localization/locales                           | List all locales                         |
| GET    | /localization/translations/{locale}/{namespace} | Get key-value map for a locale+namespace |
| POST   | /localization/translations                      | Upsert a single translation key          |
| DELETE | /localization/translations/{id}                 | Delete a translation by id               |

Contract slice: `packages/contracts/orpc-contract/src/localization.ts`
Controller: `src/router/index.ts` (`LocalizationController`)

## Prisma tables

| Model         | Table         | Notes                                                                  |
| ------------- | ------------- | ---------------------------------------------------------------------- |
| `Locale`      | `locale`      | Supported locales (code, name, isDefault)                              |
| `Translation` | `translation` | Key-value strings scoped by localeId + namespace + key (unique triple) |

Do not add `tenantId` to these tables unless making the platform multi-tenant for i18n - locales are typically global.

## Events emitted

| Event                               | Payload                      | When                    |
| ----------------------------------- | ---------------------------- | ----------------------- |
| `localization.translation.upserted` | `{ locale, namespace, key }` | After successful upsert |
| `localization.translation.deleted`  | `{ id }`                     | After successful delete |

Subscribe via `ctx.events.on('localization.translation.upserted', handler)` in a plugin.

## Ports

None. All data is stored in the local DB. No external vendor integrations.

## Extension points

- Add a new route: `/scaffold-route localization <method> <path>`
- Add per-tenant locale sets: add `tenantId` to `Locale` and use the `withTenant` helper
- Add bulk import: add a `bulkUpsert` method to `LocalizationService` that accepts a flat JSON map
- Add locale fallback chain: implement in `getTranslations` - query preferred locale, fall back to default
- Expose translations via MCP: `ctx.mcp.tool(...)` in the plugin's `register` to let AI read/write strings

## Do

- Use `PrismaService` for all DB queries
- Throw `LocaleNotFoundError` / `TranslationNotFoundError` from the service; map to `ORPCError` in the controller
- Call `this.events.emit(...)` AFTER the DB write succeeds
- Keep business logic in the service, not the controller

## Don't

- Import from other modules
- Add HTTP-specific logic (status codes, headers) to `LocalizationService`
- Store translations in flat files - the DB is the source of truth
- Query `locale` or `translation` tables directly from other modules - emit events or add a dedicated query method
