---
'@openora/core': patch
---

Three fixes:

- The daily streak now qualifies on `WagerTrackingArgs.realAmount` (the own-money part of a
  stake) instead of the full stake, matching `RaceService`/`RankChallengeService` - a
  bonus-funded bet no longer advances the streak.
- A ban (`identity.user.deactivated`) now forfeits a player's active bonus grants the same way
  a self-exclusion, a cooling-off period or an account closure already do.
- `NotificationsService` gains `getById`, and the notifications module now pushes any created
  notification onto its realtime channel from a `notifications.created` subscription rather
  than only from its own dispatch jobs - so a consumer that calls `create()` on its own
  `NotificationsService` instance for an event outside `domainEventSchemas` (both share the
  same event bus) gets the same live push core's own notifications already did.
