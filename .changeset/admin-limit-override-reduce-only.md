---
'@openora/core': minor
---

**The admin responsible-gambling limit override is now reduce-only.** An admin could raise a limit the player had set for themselves, which is the single most sensitive RG write on the platform: it hands back the exact protection the player asked for, immediately, with none of the cool-down the player's own path enforces. `setPlayerLimit` now refuses a raise server-side with a typed `LimitRaiseNotAllowedError` (mapped to `CONFLICT`), carrying the prior and requested value so a client can build its own sentence. Creating a first limit and lowering an existing one are unchanged and still apply immediately. See ADR-0037.

**Breaking input change on `setPlayerLimit`.** `SetPlayerLimitInputSchema` gains two required fields: `reason` (a non-empty trimmed string, the documented justification) and `confirm: z.literal(true)`. Any existing caller that does not send both now fails validation. The player's own self-service path is untouched and takes neither.

The refusal is decided inside the same advisory lock and transaction that reads the existing row, so a raise that only loses a race is refused too, rather than landing because it read a stale value.

`reason` rides the `rg.limit.set` event into the audit record. **Event version bump: `rg.limit.set` -> 4**, adding `reason: string | null`. The player path always emits `null`; a non-null `reason` is therefore the marker of an admin override, and subscribers can branch on it without a second lookup.

Two new notification types, both in-app only:

- `rg.limit.admin_updated` - the player is told when an admin changes their limit, naming the prior and new value. `RgService.setPlayerLimit` already mails the player on this same write, so this deliberately does not send a second email, and the admin's `reason` is never shown to the player.
- `chat.rain.received` - a rain recipient is now notified with the sender's username and their per-recipient share. Rain is high-frequency chat social play, not a transactional money event, so it is in-app only, matching `wallet.bonus_rollover.completed`.
