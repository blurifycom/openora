---
'@openora/core': minor
---

`cms.banner.image.deleted`, `cms.banner.configuration.deleted` and `cms.banner.image.set` now carry `droppedImageUrls` - the image URLs the mutation stopped referencing (a deleted row's URLs, a configuration's cascaded rows, or the half an upsert overwrote), so a consumer that owns the object storage can clean the objects up. It reports this row only; the consumer still checks no other row reuses a URL. Additive: the field defaults to `[]`, and `EventBus` now parses inbound payloads so a queued pre-upgrade envelope also reaches handlers with the default applied.
