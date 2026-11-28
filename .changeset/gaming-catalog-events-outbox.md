---
'@openora/core': patch
---

Writes the gaming catalogue events (`gaming.tag.*`, `gaming.provider.*`, `gaming.category.*`, `gaming.game.*`, `gaming.games.*`) to the outbox in the transaction that changes the catalogue, instead of emitting them best-effort after commit. The audit record of an admin catalogue change is no longer lost when the process stops between commit and emit, and a refused change leaves no event. Payloads are unchanged.
