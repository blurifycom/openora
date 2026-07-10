---
'@openora/core': patch
---

Fix two plugin-host boot failures surfaced by a real consumer deployment (BullMQ + the full default plugin set):

- Break the `wallet` <-> `tag` circular plugin dependency. `wallet` no longer declares `dependsOn: 'tag'` - its use of tag's `PLAYER_TAGS` port is optional and resolved lazily in the router factory (`c.has(PLAYER_TAGS)`), which runs after every plugin has registered, so the port is bound regardless of load order. `tag -> wallet` (a hard `WALLET_READER` dependency) is kept.
- Default the BullMQ worker concurrency to `1` when a worker registers without one. BullMQ rejects an explicit `concurrency: undefined`, which crashed boot whenever `REDIS_URL` was set and a worker (e.g. the RG evaluators) omitted the option.
