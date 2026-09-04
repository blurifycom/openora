# CMS

The content module: static pages, and the banner placement/configuration/image model this file
focuses on.

`docs/catalog.json` is the exhaustive list of this module's tables, routes and events. This file
does not repeat it.

## What this module owns

- **Pages.** A slug-addressed content record with a publish gate - draft pages 404 on the public
  read path exactly like a nonexistent slug, so there is no draft-existence leak.
- **Banner placements.** A placement is a free-form operator key (a page section, a slot name -
  whatever the consuming frontend calls it) with zero or more `bannerConfiguration` rows, each a
  layout plus a set of `bannerImage` rows.
- **Banner image URLs, not banner image bytes.** A `bannerImage` row carries a desktop URL, a
  mobile URL, and an optional link - never a file. This module has no upload endpoint and no
  storage adapter; see "Expected consumer integration" below.

## The placement -> configuration -> default model

- A **placement** is nothing more than the string every `bannerConfiguration` for that section
  shares. It has no row of its own - `listBannerPlacements` derives the placement list from the
  distinct `placement` values on `bannerConfiguration`.
- A **configuration** is a named layout (`carousel` | `grid` | `single`) plus the images that go
  with it. An operator can keep several configurations per placement - a seasonal swap, an A/B
  draft - and only one is ever live.
- **Exactly one default (= "live") configuration per placement** is the invariant. It is enforced
  in the database, not in application code: `banner_configuration_default_per_placement_idx` is a
  partial unique index on `placement` `WHERE is_default = true`. `setDefaultConfiguration` clears
  any other default for the placement and sets the new one inside the same transaction, so two
  concurrent "make me the default" calls can never both win - the index rejects the loser.
- Each layout has an image-count bound (`BANNER_IMAGE_COUNT_BOUNDS` in the contract): `single`
  needs exactly 1, `grid` needs exactly 3, `carousel` needs 2-6. `setDefaultConfiguration` checks
  the configuration's slot count (distinct `sortOrder` among its default-locale images) against
  its layout's bounds before promoting it, and refuses with `BannerConfigurationImageCountError`
  otherwise - a placement can never go live half-built.
- Deleting a configuration that is the current default is refused
  (`BannerConfigurationIsDefaultError`) - unset or replace the default first, then delete.

## Scheduling a banner ahead of time

A non-default configuration can carry at most one `bannerSchedule` row - a `[startsAt, endsAt)`
window that makes it the placement's live banner for that window, then automatically reverts to
the standing default, with no admin action at either boundary:

- **`createBannerSchedule`** (`POST /cms/banner-configurations/{id}/schedule`) targets a
  configuration that is not itself the default, in a placement that already has one (a schedule
  layers onto a default, it doesn't replace the concept of one). `startsAt` must be in the future;
  `endsAt` must be after `startsAt`; a configuration that already has a schedule refuses a second
  one (`BannerConfigurationHasScheduleError`) - schedule a fresh configuration instead. An
  overlapping window on the same placement is refused with `BannerScheduleOverlapError`, which
  carries the conflicting schedule's own `startsAt`/`endsAt` so the caller can show the collision
  without a second lookup; two schedules that only touch at a boundary
  (`new.startsAt === existing.endsAt`) do not conflict.
- **`updateBannerScheduleEnd`** (`PUT /cms/banner-configurations/{id}/schedule`) edits `endsAt`
  only - there is no route to change `startsAt` or to cancel a schedule outright. Moving `endsAt`
  to now or the past is how a live schedule is ended early. The overlap check reruns, excluding
  the schedule's own configuration.
- **`listBannerSchedulesByPlacement`** (`GET /cms/banner-placements/{placement}/schedules`) lists
  every schedule for a placement, ordered by `startsAt`, each with its configuration's summary.
- **"What's live" is resolved at read time inside `getPublicBanner`**, not by a background job:
  a schedule whose window contains `now()` wins over the placement default, otherwise the default
  renders as before - same auto-expiry approach as `rgExclusion` in the compliance module. This
  means a schedule boundary can lag by up to the same `CMS_CACHE_TTL_MS` this module already
  accepts for any other public-read staleness; nothing needs to invalidate the cache at the
  boundary itself.
- **Deleting a configuration with any attached schedule is refused unconditionally** - queued,
  currently active, or already expired all fail the same way
  (`BannerConfigurationHasScheduleError`). An expired schedule's configuration simply stays around
  as an inert row; there is no cleanup job for this ticket's scope.

## Locales

A `bannerImage` row's `locale` defaults to the sentinel `DEFAULT_LOCALE` ('default'), which is
also the locale every image-count and layout check runs against. A locale override reuses an
existing `sortOrder` slot rather than adding one: `setBannerImage` upserts on
`(bannerConfigurationId, sortOrder, locale)`, so calling it twice for the same key updates the row
in place. The public read (`getPublicBanner`) resolves slots from the default-locale rows, and for
each slot swaps in the requested locale's row when one exists, otherwise falling back to the
default-locale row for that slot - a partially translated configuration still renders completely.

## Image URLs and the host allow-list

Core never touches image bytes. `bannerImage.desktopImageUrl` / `mobileImageUrl` are validated
against `PlatformConfig.cms.allowedBannerImageHosts` (mirroring the chat-attachment host
allow-list): `https:` only, and the hostname must equal or be a subdomain of an allowed entry.
A URL that fails validation is rejected with `BannerImageHostNotAllowedError` before it is ever
written - `allowedBannerImageHosts` empty means no banner images can be set at all.

## Expected consumer integration

This module is intentionally silent about where images come from. A downstream operator wires:

- **Its own image upload and storage pipeline**, entirely outside this contract - object storage,
  a CDN, a DAM, whatever it already runs. Core has no upload endpoint and never will; that keeps a
  storage vendor out of the contract this repository owns.
- **`PlatformConfig.cms.allowedBannerImageHosts`**, pointed at wherever that pipeline serves
  images from (its CDN hostname, its bucket's public hostname, etc.) - otherwise every
  `setBannerImage` call is rejected.
- **The admin routes** (`listBannerPlacements`, `listBannerConfigurationsByPlacement`,
  `createBannerConfiguration`, `getBannerConfiguration`, `setBannerImage`, `deleteBannerImage`,
  `setDefaultBannerConfiguration`, `unsetDefaultBannerConfiguration`, `deleteBannerConfiguration`,
  `createBannerSchedule`, `updateBannerScheduleEnd`, `listBannerSchedulesByPlacement`) from its
  backoffice, to manage configurations, images, and schedules per placement.
- **The public route** (`getPublicBanner`) from its player-facing app, to render the live
  configuration for a placement - `{ placement, layout, slots }`, `null` when nothing is live yet.
