---
'@openora/core': minor
---

`GrantLifecycleService.forfeit()` now takes an optional actor instead of a required one, so a scheduled job can forfeit a single named grant (an Activity Bonus that missed a required wagering day, for example) with no admin session to assert - the same system-actor path `forfeitAllFor` already supported. `BONUS_FORFEIT_REASONS` gains `terms_breach` (new enum value on `promo_forfeit_reason`) for offer-terms breaches a job detects rather than an admin or an RG event.
