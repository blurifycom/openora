# CMS

Public content: pages (`cms.pages`) and placement-keyed banners (`cms.banners`). Admin CRUD guarded by `AdminGuard` (`content` resource).

`listPages`/`getPage` are unauthenticated and HTTP-cacheable (see `PUBLIC_HTTP_CACHE_PATHS`), so the service filters both to `publishedAt IS NOT NULL` - a draft is invisible to the public reads (an unpublished slug 404s the same as a nonexistent one, no draft-existence leak). There is no admin listing/get-by-id for drafts yet; `updatePage`/`deletePage` take the page `id` returned by `createPage`.

Caching: `getPage` and `listBannersByPlacement` cache through the `CACHE` port (60s TTL). Page/banner create/update/delete invalidate the affected slug/placement key(s) in the same service method. The default `CACHE` binding is in-process (per replica) - a multi-instance deployment needs a Redis-backed (or event-driven) `CACHE` overlay for cross-instance invalidation, or reads on other replicas can serve a stale page/banner for up to the TTL after a mutation.
