# Player Management

Operator-facing player CRUD, search, and analytics over the `player` table (lifetime wagered/deposit totals live here). Search leans on a trigram GIN index on `display_name` for ILIKE - the DB needs `pg_trgm`.

## Invariants

- Owns and binds `KYC_STATUS_WRITER`; compliance drives every KYC transition through that port (submit, webhook reconcile, threshold re-KYC, admin resubmit/override/bulk-approve), never by writing `player`.
- `update` does NOT accept `kycStatus`. A KYC transition is a regulated compliance action needing a mandatory reason and an append-only `kyc_verification` history row, neither of which a general-purpose patch captures - `compliance.overrideKycStatus` (`POST /compliance/players/{userId}/kyc/override`, `compliance:override-limit`) supersedes it. `PlayerService` takes no `KycStatusWriter` and never writes `player.kycStatus`.
- `remove` bans the player; players are never hard-deleted.
- `update`/`remove` emit no domain event (no `player.updated`/`player.removed` topic exists) - the router records `admin.player.updated`/`admin.player.removed` directly through `AUDIT_WRITER`, fetching the pre-mutation row for the `before` snapshot. No audit call happens when `adminGuard.assert` rejects the caller first.

`PlayerKycStatusWriter.setStatus` (`service/kyc-status-writer.ts`) is a single conditional `UPDATE player SET kyc_status = $new FROM (SELECT kyc_status FROM player WHERE user_id = $1 FOR UPDATE) AS prev WHERE ... AND prev.kyc_status <> $new RETURNING prev.kyc_status` - not select-then-update - so concurrent callers across instances can't both pass a stale guard and double-emit `compliance.kyc.updated`. Zero rows back is ambiguous (already at target vs missing player row), disambiguated by a follow-up existence check that throws `PlayerNotFoundError` for the latter rather than silently no-opping. The `FROM (... FOR UPDATE)` subquery captures the pre-update value inside that same atomic statement, so `previousStatus` on the emitted event can never be stale.

`update()` emits `player.level.changed` (`{ userId, previousLevel, newLevel, actorId }`) after the transaction commits whenever `data.level` is provided and differs from the existing row's level - a best-effort fan-out (unlike the `KYC_STATUS_WRITER` emit, which runs inside the transaction as a regulated single-writer seam). The `tag` module subscribes to it to keep its single mutable `level` tag in sync.

Known pre-existing gap (not introduced or fixed here): `playerContract.update`'s `email` field is accepted by the contract and by `PlayerService.update`'s signature, but the router never forwards `input.email` into the service call - an admin-submitted email change is silently a no-op.

## `playerSearch`/`playerProfile` are player-facing, not admin-facing

Unlike every other route in this module, `playerSearch` (`GET /players/search`) and `playerProfile`
(`GET /players/{userId}/profile-card`) are NOT `adminGuard`-gated - any authenticated player can
call them. They power the chat `/profile` command's search step and profile card (ported from
`chat-commands`, which used to own them) and take a `viewerId` resolved from `getUserId(context)`,
not an admin caller. `playerProfile` looks up by identity `userId` (like `getByUserId`), never the
PAM `playerId` that `get`/`update`/`remove` take. Wagered totals/currency/joinedAt on the profile
card are self-only - a viewer looking at someone else's card only ever sees username/level/avatar.

`searchPlayers` excludes any player the viewer has blocked or ignored via
`CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)` (a moderation feature - a blocked/ignored player
will not surface in search). This is why this module now depends on `chat` (`dependsOn: ['chat',
'gaming', 'audit']`) and DI-resolves `CHAT_BLOCK_WRITER` in `plugin.ts` - the sanctioned
command-port cross-domain pattern (same one `chat-commands` already used), not a boundary
violation. `ADMIN_GAME_REPORTING` (bound by `gaming`) supplies the self-only wagered/bet stats on
the profile card.
