---
'@openora/core': minor
---

A player entering a cooling-off period now forfeits every active bonus immediately, the same as a self-exclusion or account closure. `BONUS_FORFEIT_REASONS` gains `cooling_off` (new enum value on `promo_forfeit_reason`), and the bonus plugin now also subscribes to `rg.cooling_off.activated`.
