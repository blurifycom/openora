---
'@openora/core': patch
---

`DrizzleService` exposes an opt-in `replica` that routes selects to `DATABASE_REPLICA_URLS` (falls back to the primary when unset), and `DATABASE_POOL_MAX` caps each pool. Public game catalog reads go through the replica and a 30s cache that every catalog admin write and the category rank/membership jobs drop at once.
