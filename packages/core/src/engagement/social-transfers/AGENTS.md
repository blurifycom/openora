# social-transfers

Owns all player-to-player money movement that flows through the chat command surface: `/gift` (claimable gift card), `/rain` (split among online room members), `/donate` (direct tip to a known username). Ported from `chat-commands`, which used to implement all three directly - see that module's AGENTS.md for what moved and why. `sendDonate` is this module's own oRPC operation; gift send/claim and rain send are exposed to `chat-commands` only through the `GIFT_COMMANDS`/`RAIN_COMMANDS` command ports - `chat-commands`' `postGift`/`claimGift`/`postRain` are pure delegation, this module owns every part of the mechanics, including posting and publishing the resulting chat message.

## This module never queries chat's presence tracking - it takes recipient ids as input

`/rain` needs to know who is online, but that lookup does NOT happen here. `chat-commands` already depends on this module (for `GIFT_COMMANDS`), so this module depending back on `chat-commands` - or on `chat`'s `CHAT_REALTIME_TRANSPORT.getOnlineUserIds` specifically for presence - would create an import cycle. Instead `RAIN_COMMANDS.sendRain`'s input carries `onlineUserIds: Uuid[]`, resolved by `chat-commands` (which owns presence for the whole chat-command surface) BEFORE it calls this port. `doSendRain` does exactly what it always did with that list - filter out the actor, shuffle, cap to `recipientCount`, report `no_online_users` if nothing is left - it just no longer fetches the list itself. See `chat-commands/AGENTS.md` for the full reasoning.

This module still depends on `chat` directly for gift/rain/donate/claim: `CHAT_SYSTEM_WRITER` (each
command's system-message insert runs inside ITS OWN `db.transaction`, atomic with the wallet move),
`CHAT_ROOM_ACCESS` (room-membership verification before any money moves, all three commands), and
`CHAT_REALTIME_TRANSPORT.publish` (the post-commit realtime push for gift/rain/donate/claim - see
"Publish-after-commit"). Only rain's presence QUERY moved to the caller; everything else threaded
through a transaction stays here.

## Idempotency for money-moving commands (gift/rain/donate)

All three require a client `idempotencyKey` (uuid). The `CACHE` port reserves
`chat-command:idempotency:{actorId}:{commandType}:{idempotencyKey}` atomically with a five-minute
TTL (the key namespace stays `chat-command:*` even though the logic now lives here - it is an
internal Redis key, not part of any public contract), stores the full-request fingerprint, and then
stores the completed `ChatSystemMessage` under the same key. A matching fingerprint replays without
another wallet call; a different fingerprint throws `ChatCommandIdempotencyKeyReuseError`; a
concurrent in-flight request throws `ConcurrentCommandReplayError`. Failed money transactions
release the reservation for all three commands - the reservation guard wraps the whole
`db.transaction(...)` call, so a failure anywhere inside it (wallet debit/credit, the system-message
insert, the audit row) releases the reservation and a retry is free to try again. The cache must
provide atomic `setIfAbsent` - a plain get-then-set is not safe for money. There is NO separate DB
table for idempotency, it's Redis/CACHE-only. A rain replay does not re-validate or re-use
`onlineUserIds` at all - the caller resolves presence unconditionally before calling in, even on a
request that turns out to be a replay (a minor, accepted trade-off: one extra
`CHAT_REALTIME_TRANSPORT` call on a replay, in exchange for social-transfers never touching
presence).

## Publish-after-commit for gift/rain/donate/claim

`ChatSystemWriter.postSystemMessage` only auto-publishes to realtime when it owns the write (no
`tx` argument). `doSendGift`/`doSendRain`/`doSendDonate`/`doClaimGift` all pass their own `tx`, so
they own the commit boundary and must call `this.transport.publish(chatChannel(...), msg)`
themselves, AFTER their `db.transaction(...)` call resolves - never before, or a client could see a
gift/rain/donate message for money that was never actually moved (transaction rolled back after the
publish). Money movement and the system-message row commit atomically together in every one of the
four commands; there is no exception.

## Claimable gift mechanic

`/gift <amount>` is a two-step flow: the sender is debited immediately and a `player_gift` row
(status: unclaimed) is created atomically with the system message. Any other player calls
`GIFT_COMMANDS.claimGift` (via `chat-commands`' `POST /chat-command/gift/:id/claim`) to win the
credit. The atomic claim uses `UPDATE ... WHERE claimed_by IS NULL RETURNING *` - first caller wins,
zero balance goes unreturned. Realtime push fires on claim via
`CHAT_REALTIME_TRANSPORT.publish(chatChannel(roomId), ...)`.

`playerGift.messageId` is a plain UUID with no FK - cross-module boundary rule applies.

### The old `chat_gift` table is a deliberate, deferred follow-up

`player_gift` is the successor to chat-commands' `chat_gift` table (same shape). `chat_gift` and its
migration are left untouched in `chat-commands` - there may be prod data in it and no migration/
backfill plan has been decided. New gift rows go to `player_gift` only; nothing reads or writes
`chat_gift` anymore. Reconciling/retiring the old table is out of scope until that plan exists.

## Rain has a remainder - debit the distributed amount, not the typed amount

`/rain <amount>` splits `floor(amount / recipientCount)` to each recipient - `perRecipient *
recipientCount` can be LESS than the player-typed `amount` (eg `10.99` split 10 ways credits
`10.00` total). `doSendRain` debits `totalDistributed` (`floor(amount/n)*n`, computed in the same
SQL statement as `perRecipient`), never the raw `input.amount` - otherwise the undistributed
remainder is silently taken from the sender and never credited anywhere. The system-message
metadata (built by `doSendRain` itself), audit `after.amount`, the persisted
`player_rain.amount`, and the `chat.rain.distributed` event's `totalAmount` all report
`totalDistributed` too, since that is what actually left the sender's wallet. The pre-transaction
`maxAmount`/`minAmount`/`amountUnits` limit checks still validate against the player-typed
`input.amount` - that happens before the split is known and is correct as-is. `player_rain` is a new
header row per rain event (nothing was persisted before this module existed); `player_rain_receiver`
has one row per recipient, in-module FK to `player_rain.id`.

## Exact username resolution for `/donate`

`/donate` resolves an EXACT, already-known username (typed in full or picked from autocomplete,
never a partial search term) via `resolveExactPlayer`, which calls
`ADMIN_USER_DIRECTORY.getPlayerByUsername` - a real exact, case-insensitive match. It does NOT use
`findPlayerIds` (that method is a capped, unordered `ILIKE '%query%'` substring search meant for
autocomplete-style fuzzy search): a short/common username can substring-collide with more than the
20-row cap of unrelated accounts, so the real target could fall outside the first 20 rows Postgres
happens to return and get a false `ChatPlayerNotFoundError`. `player_donate` is a new table (nothing
was persisted before this module existed - donate previously only moved wallet balances and posted
a chat message).

## Command config gate - read-only cross-module schema import

Each of gift/rain/donate is gated by a row in `chat_command_config` (owned by `chat-commands`,
keyed by command type) - a missing or disabled row throws `CommandDisabledError`; `config.minAmount`/
`config.maxAmount`/`config.maxRecipients` (rain only) are enforced from the SAME row. This module
imports the `chatCommandConfig` table definition from `@openora/core/engagement/schema/chat-commands`
(the sanctioned read-only cross-module `/schema` import - `db-conventions`/`clean-architecture`) and
queries it with its own `DRIZZLE` connection (one shared Postgres database). It never writes that
table - toggling a command is out of scope for both modules until an admin route is reintroduced
somewhere.

## GIFT_COMMANDS / RAIN_COMMANDS ports - result type, not throw, across the module boundary

`sendGift`/`claimGift`/`sendRain` never throw for an EXPECTED failure (disabled, insufficient
balance, limits, no online users, too many recipients, idempotency reuse/replay, room membership,
gift not found/claimed/self-claim) - they return `{ ok: false, reason }` instead, because
`chat-commands`' router can't `instanceof`-match an error class defined in this module without a
forbidden cross-module internals import. `toSendGiftResult`/`toClaimGiftResult`/`toSendRainResult` do
this translation once, at the very edge of each port implementation; only a genuinely unexpected
error still throws across the port (mirrors `WALLET_COMMANDS`' `{ ok: false, ... }` outcome pattern -
ADR-0017). `sendDonate` is NOT behind a port (it's this module's own route, `chat-commands` never
calls it), so it stays throw-based like every other module's router-facing service method.

## Ports consumed

- `CHAT_SYSTEM_WRITER` - posts system messages into the chat stream for gift/rain/donate, inside
  each command's own transaction (bound by `chat`).
- `CACHE` - atomic Redis-backed idempotency reservation and short-lived replay result storage.
- `WALLET_COMMANDS` - debits the actor and credits recipient(s) within a single transaction; money
  never flows over events.
- `ADMIN_USER_DIRECTORY` - `lookupPlayers` for batch profile resolution, `getPlayerByUsername` for
  exact-match resolution of an already-known username (`/donate`).
- `AUDIT_WRITER` - transactional `recordInTransaction()` for gift/rain/donate money paths, so the
  audit row commits or rolls back with the wallet move.
- `CHAT_REALTIME_TRANSPORT` - `publish(channel, event)` for gift-claimed push and gift/rain/donate
  system messages, AFTER each transaction commits. The chat-scoped token, not the generic
  `REALTIME_TRANSPORT` - this module publishes on the same `chat:*` channels chat itself uses.
  `getOnlineUserIds` is NOT used here - see "This module never queries chat's presence tracking"
  above.
- `CHAT_ROOM_ACCESS` - `verifyRoomAccess` before any money moves into a room.

## Invariants

- Gift send: debit + `playerGift` insert + system message are atomic in one transaction.
  `messageId` is back-filled in the same transaction after `postSystemMessage` returns.
- Gift claim: the `UPDATE ... WHERE claimed_by IS NULL` is the idempotency guard - no separate lock
  needed. Self-claim is rejected before the update attempt.
- Rain recipients are capped by `config.maxRecipients` (default 50) and filtered to exclude the actor
  from the caller-supplied `onlineUserIds` list.
- Gift/rain/donate money movement is fully transactional: debit + credits + system message +
  persisted row(s) happen atomically, in every one of the three commands.
- Money-moving audit rows are written through the same transaction as the debit/credit and the
  system message.
- `mapConcurrent` (limit 10) is used for rain credits - never `Promise.all` on an unbounded
  recipient list.

## Don't

- Don't write to `chat_gift` (chat-commands' table) - it is frozen, not extended.
- Don't add a DB-backed idempotency table for gift/rain/donate - CACHE/Redis is the single source
  of truth for replay guards here.
- Don't call `CHAT_REALTIME_TRANSPORT.getOnlineUserIds` (or otherwise reach for chat presence) from
  this module - `chat-commands` resolves recipients and passes them into `RAIN_COMMANDS.sendRain`.
- Don't split rain's chat-message write out of its own transaction (eg via a callback owned by
  another module) - `doSendRain` posts the system message and persists the money move atomically,
  the same as `doSendGift`/`doSendDonate`.
