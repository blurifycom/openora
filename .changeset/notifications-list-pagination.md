---
'@openora/core': minor
---

`GET /notifications` now returns the shared offset-pagination envelope (`{ items, total, page, limit }`, via `paginated(NotificationSchema)`) instead of a bare `Notification[]`, and accepts `page`/`limit`/`sortBy`/`sortOrder` query params.

BREAKING CHANGE: a consumer reading the old bare-array response (e.g. calling `.map()` directly on the payload) must switch to reading `.items` off the new envelope. The `useNotifications` React hook already returns the paginated shape.
