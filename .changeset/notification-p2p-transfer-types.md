---
'@openora/core': minor
---

Adds three notification types for player-to-player transfers: `chat.tip.received`, `chat.gift.claimed`, `chat.gift.expired`, alongside the existing `chat.rain.received`. Additive to the closed `NotificationTypeSchema` enum; no consumer of the existing types is affected.
