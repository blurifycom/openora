# CMS Module - AGENTS.md

## What this module does

Manages content for the platform: Pages (long-form content addressed by slug) and Banners
(promotional images/links grouped by placement). Operators create and update content via the
backoffice; players see pages and banners on the frontend. Content blocks are stored as JSON
in Postgres. Publishes a `cms.page.published` event whenever a page transitions to published.

## Files

| File                         | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/schemas/index.ts`       | Re-exports from `@oss/domain-schemas` and `@oss/orpc-contract/cms` (PageSchema, BannerSchema, cmsContract). Infers `Page` and `Banner` types. |
| `src/service/cms.service.ts` | Business logic: full CRUD for Page and Banner. Throws `PageNotFoundError` / `BannerNotFoundError` on missing records.                         |
| `src/service/ports.ts`       | Empty - no third-party adapters needed.                                                                                                       |
| `src/router/index.ts`        | `CmsController` - maps oRPC procedures to service calls, catches domain errors and re-throws as `ORPCError`.                                  |
| `src/ui/page-preview.tsx`    | Renders a page title and content blob. Depends on `UIProvider.Card`.                                                                          |
| `src/ui/banner-list.tsx`     | Renders a list of banners. Depends on `UIProvider.Card`.                                                                                      |
| `src/plugin.ts`              | `definePlugin` entry; registers `CmsService` + `CmsController`.                                                                               |
| `prisma.partial.prisma`      | `Page` and `Banner` models. Merged by `pnpm regen`.                                                                                           |

## Extension points

- **New routes** - add to `src/router/index.ts` and extend `cmsContract` in `packages/contracts/orpc-contract/src/cms.ts`.
- **New events** - emit via `this.events.emit(...)` from `CmsService`. Declare event type in `packages/platform/events/src/types.ts`.
- **UI slots** - add new components in `src/ui/` and fill named slots in an overlay plugin via `ctx.slots.fill(...)`.
- **Ports** - if a CDN or image-upload adapter is ever needed, declare an interface in `src/service/ports.ts` and inject it into `CmsService`.

## Events emitted

| Event                | Payload                            | Trigger                                    |
| -------------------- | ---------------------------------- | ------------------------------------------ |
| `cms.page.published` | `{ pageId: string, slug: string }` | Page first gains a non-null `publishedAt`. |

## Do

- Add new content types as new Prisma models in `prisma.partial.prisma` + new methods in `CmsService`.
- Throw typed domain errors (`PageNotFoundError`, `BannerNotFoundError`) from the service layer.
- Map domain errors to `ORPCError` in the router layer only.
- Keep all Zod schemas in `packages/contracts/orpc-contract/src/cms.ts` or `src/schemas/index.ts`.

## Don't

- Import from other modules directly (`@oss/module-wallet`, etc.).
- Throw `HttpException` from `CmsService`.
- Write ad-hoc Zod schemas inside handlers or service methods.
- Edit `infra/prisma/schema.prisma` directly - use `prisma.partial.prisma` and run `pnpm regen`.
- Touch `packages/contracts/orpc-contract/src/index.ts` - the cms contract is accessed via the `./cms` sub-path export.
