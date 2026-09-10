---
'@openora/core': minor
---

`cms.banner.image.deleted`, `cms.banner.configuration.deleted` and `cms.banner.image.set` now carry `droppedImageUrls` - image URLs no remaining banner image row references after the mutation, so a consumer that owns the object storage can clean the objects up. Additive: the field defaults to `[]`, and `EventBus` now parses inbound payloads so a queued pre-upgrade envelope also reaches handlers with the default applied.
