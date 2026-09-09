---
'@openora/core': minor
---

Banner mutations now say which image URLs they stopped referencing, so a consumer that owns the object storage behind them can delete the orphans. `cms.banner.image.deleted`, `cms.banner.configuration.deleted` and `cms.banner.image.set` each carry `droppedImageUrls`: the deleted row's two URLs, every URL the FK cascade takes with a configuration (read inside the transaction, before the rows are gone), and whatever an upsert overwrote minus any URL the new row reuses. Previously the events named only ids and fired after the rows were deleted, so the URLs were unrecoverable downstream and every uploaded image outlived the banner that used it. Additive to the payloads; existing consumers are unaffected.
