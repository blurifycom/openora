---
'@openora/core': patch
---

Writes the gaming admin catalogue events (tags, providers, categories, game edits, bulk changes, review) and the category membership evaluation events to the outbox in the transaction that changes the catalogue, instead of emitting them best-effort after commit. The audit record of such a change is no longer lost when the process stops between commit and emit, and a rolled-back change leaves no event. Not covered: `setGameAvailabilityInTransaction` still never emits, so its caller writes `gaming.game.availability_changed` with `emitInTransaction` on its own transaction, and `notifyGamesCreated` and `notifyGamesChanged` run after the importer has committed, so their events are durable from that point but not atomic with the import. `lobby.layout.updated` is written to the outbox in the layout replace transaction. Payloads are unchanged.
