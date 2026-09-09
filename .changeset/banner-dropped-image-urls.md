---
'@openora/core': minor
---

Banner mutations now say which image URLs they stopped referencing, so a consumer that owns the object storage behind them can evaluate the objects for cleanup. `cms.banner.image.deleted`, `cms.banner.configuration.deleted` and `cms.banner.image.set` each carry `droppedImageUrls`: the deleted row's two URLs, every URL the FK cascade takes with a configuration (read inside the transaction, before the rows are gone), and whatever an upsert overwrote minus any URL the new row reuses. The field describes references removed by this row only; storage owners must still verify that another row does not use the same URL before deleting an object. Previously the events named only ids and fired after the rows were deleted, so the URLs were unrecoverable downstream. Additive to the payloads; older queued payloads default the field to an empty list.
