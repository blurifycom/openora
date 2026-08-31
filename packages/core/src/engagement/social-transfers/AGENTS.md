# social-transfers

Owns all player-to-player money movement that flows through the chat command surface: `/gift` (claimable gift card), `/rain` (split among online room members), `/donate` (direct tip to a known username). Ported from `chat-commands`, which used to implement all three directly - see that module's AGENTS.md for what moved and why. `sendDonate` is this module's own oRPC operation; gift send/claim and rain send are exposed to `chat-commands` only through the `GIFT_COMMANDS`/`RAIN_COMMANDS` command ports - `chat-commands`' `postGift`/`claimGift`/`postRain` are pure delegation, this module owns every part of the mechanics, including posting and publishing the resulting chat message.

## Global chat uses the GLOBAL_CHAT_ROOM_ID sentinel on the wire, `null` internally

`/gift`, `/rain`, and `/donate` can all target global chat, not just a room. The wire contract
(`PostGiftInputSchema`/`PostRainInputSchema` in `chat-commands/contract/`, `SendDonateInputSchema`
here) types `roomId` as `ChatRoomIdSchema` (`packages/core/src/contracts/schemas/chat-command.ts`):
a real room UUID, or the literal string `GLOBAL_CHAT_ROOM_ID` (`'__global'`) - callers never send a
raw `null`. The schema's `.transform()` normalizes `'__global'` to `null` before the handler ever
runs, so every internal type (`SendGiftArgs`/`SendRainArgs`/`DonateArgs.roomId`, `player_gift.roomId`,
`player_rain.roomId`) is `Uuid | null`, `null` meaning global chat - the same representation
`chatChannel()` and the `chat` module's own `roomId: null` already use. `verifyRoomAccessIfNeeded`
skips room-membership verification entirely when `roomId` is `null` (global chat has no membership
gate). Never reintroduce a raw nullable `roomId` on a wire schema here - always `ChatRoomIdSchema`,
so there is exactly one way to address global chat at the HTTP boundary.

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
credit. `doClaimGift` opens its transaction with `SELECT ... FOR UPDATE` on the target `player_gift`
row (same pattern as wallet's guarded debit) to serialize concurrent claims, THEN checks
self-claim/already-claimed against the locked read, THEN does a guarded conditional
`UPDATE ... WHERE claimed_by IS NULL RETURNING *` as defense-in-depth on top of the lock - first
caller wins, zero balance goes unreturned. Realtime push fires on claim via
`CHAT_REALTIME_TRANSPORT.publish(chatChannel(roomId), ...)`.

`playerGift.messageId` is a plain UUID with no FK - cross-module boundary rule applies.

Reading a gift's current state is a separate, read-only capability: `GIFT_COMMANDS.getGift` (via
`chat-commands`' `GET /chat-command/gift/{id}`) returns a `GiftSnapshot` (claimed/unclaimed,
claimed-by-whom) and enforces the same room-membership check as `claimGift` - a viewer must be a
member of the gift's room to poll its status. Unlike `doClaimGift`, `doGetGift` takes no row lock
(`SELECT` without `FOR UPDATE`): it's read-only, nothing to serialize against.

### Gift persistence

`player_gift` is the only persistence table for claimable gifts. The former chat-command gift table
has been retired by the chat-commands migration; new gift rows and all reads use `player_gift`.

## Rain has a remainder - debit the distributed amount, not the typed amount

`/rain <amount>` treats `amount` as the total budget and fixes `perRecipient` from the requested
`recipientCount` before the live recipient list is reduced. The per-recipient value is floored to
the platform's own stored precision (`MONEY_SCALE` = 18 decimal places, `numeric(38,18)`), NOT a
hardcoded two-decimal ("cents") step - flooring to cents was fine for fiat but wrong for an
18-decimal crypto currency, where a legitimate sub-cent split would always floor to zero and
wrongly report `TooManyRecipientsError`. `calculateRainSplit` computes this exactly: it multiplies
up to the smallest unit, takes an EXACT integer floor-division via `MOD` (never `floor(a::numeric /
b)` - Postgres' `/` targets a fixed number of significant digits before `floor()` ever sees the
result, silently truncating precision `MOD` does not lose), and shifts the decimal point back with
a plain string operation in JS (`unitsToDecimalString`) rather than a second numeric division,
which would reintroduce the same truncation. If fewer users are available, the same per-recipient
amount is paid to each selected user; the unused remainder (now at most `10^-18`, not `$0.01`)
stays with the sender. For example, `100` requested for 5 users fixes `20` per recipient; if only 4
are available, 4 users receive `20` and `80` is debited. `perRecipient` and `totalDistributed`
(`perRecipient * actual recipientCount`) are computed in the same SQL transaction. The
system-message metadata (built by `doSendRain` itself), audit `after.amount`, the persisted
`player_rain.amount`, and the `chat.rain.distributed` event's `totalAmount` all report
`totalDistributed`, since that is what actually left the sender's wallet. The event also carries
`perRecipient` verbatim, so a subscriber renders the credited share rather than re-deriving it from
`totalAmount / recipientCount`. The `maxAmount`/
`minAmount` limit checks validate against the player-typed `input.amount`; `maxRecipients`
validates the requested count. Non-even totals are valid, and there is no whole-unit
amount-versus-recipient check. `player_rain` is a new header row per rain event (nothing was
persisted before this module existed); `player_rain_receiver` has one row per recipient,
in-module FK to `player_rain.id`.

## Sender-chosen currency for gift/rain/donate - never a swap

`SendDonateInputSchema`, and the `SendGiftArgs`/`SendRainArgs` the GIFT_COMMANDS/RAIN_COMMANDS
ports accept, all carry an optional `currency` (a `CurrencyTickerInputSchema` ticker, eg `USD` or
`BTC`). Omitted, the debit falls on the sender's active currency - unchanged, pre-existing
behaviour, so this is purely additive. When supplied, `WALLET_COMMANDS.debit` is called with that
`currency`; whichever currency comes back as `debit.currency` (the one actually debited) is what
every recipient is credited in, with `allowNewCurrency: true` on every credit call (gift claim,
every rain recipient, donate) so a recipient who has never held that currency still receives it -
that flag opens their `wallet_balance` row instead of failing `currency mismatch`. This never
routes through `EXCHANGE_RATE_READER` or any conversion - the whole point is that the sender's
choice is exactly what lands in the recipient's balance, unlike a wallet swap.

A sender naming a currency they do not hold gets the SAME `insufficient_balance` failure as an
over-spend, not a distinct error: `WALLET_COMMANDS.debit` finds no balance row for a currency the
player has never held (`available: '0'`) exactly as it would for an over-spend in a currency they
do hold - no separate "do you hold this currency" check exists or is needed.

A currency the operator has disabled for deposit/withdrawal (`wallet_asset.depositEnabled`/
`withdrawalEnabled`) can still be gifted/rained/donated: those flags gate the deposit/withdrawal
rails, not spending an already-held balance, and many currencies (fiat) have no `wallet_asset` row
at all - gating gift/rain/donate on it would silently break every fiat transfer. There is
deliberately no broader "is this currency supported at all" allowlist check here beyond the
`CurrencyTickerInputSchema` format regex at the wire boundary: no such platform-wide canonical
currency list exists yet (see the `TODO` on `WalletService.setActiveCurrency`), and inventing one
scoped to this module alone would be a speculative abstraction inconsistent with the rest of the
wallet surface, which accepts any format-valid ticker today.

`chat-commands`' `CommandConfigSchema.minAmount`/`maxAmount` are keyed by currency ticker
(`Record<string, MoneyAmount>`), not a single flat amount - a minimum sensible in USD is either
meaningless or absurd in BTC, so one constant across every currency cannot be correct for both. A
currency with no entry has no limit enforced for it: an operator opts a currency INTO a limit,
never gets one by accident from a value meant for a different currency. Because the limit check
needs the ACTUAL debited currency (which, when the caller omits `currency`, is only known once
`WALLET_COMMANDS.debit` resolves the sender's active balance), `assertWithinCommandLimits` runs
AFTER `wallet.debit` succeeds, inside the same transaction - a violation throws and rolls the debit
back with everything else, same as any other in-transaction failure.

`fingerprintCommand`'s canonical replay fingerprint includes `currency`: a reused idempotency key
with a different currency is a distinct request, not a replay of the original - a replay must never
let a caller quietly swap which balance gets debited by resubmitting under a different currency.

Gift/rain/donate debits use `WalletTransactionType`s `'gift'`/`'rain'`/`'tip'`, none of which
`WALLET_COMMANDS.debit` routes through `RG_LIMITS.checkWager` (only `type === 'bet'` does) - so
these transfers do not count toward any responsible-gambling wager/deposit limit today, by
pre-existing design, not something this module changes. If that ever changes, the check must pass
its OWN resolved currency (`debit.currency`), not assume the player's default.

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
table - toggling a command's config is done by `chat-commands`' own `adminUpdateCommand`
(`PATCH /backoffice/chat-command/commands/{key}`, AdminGuard-gated on the `chat-command` resource);
see `chat-commands/AGENTS.md`.

## GIFT_COMMANDS / RAIN_COMMANDS ports - result type, not throw, across the module boundary

`sendGift`/`claimGift`/`getGift`/`sendRain` never throw for an EXPECTED failure (disabled,
insufficient balance, limits, no online users, too many recipients, idempotency reuse/replay, room
membership, gift not found/claimed/self-claim) - they return `{ ok: false, reason }` instead, because
`chat-commands`' router can't `instanceof`-match an error class defined in this module without a
forbidden cross-module internals import. `toSendGiftResult`/`toClaimGiftResult`/`toGetGiftResult`/
`toSendRainResult` do this translation once, at the very edge of each port implementation; only a
genuinely unexpected error still throws across the port (mirrors `WALLET_COMMANDS`' `{ ok: false,
... }` outcome pattern - ADR-0017). `sendDonate` is NOT behind a port (it's this module's own route,
`chat-commands` never calls it), so it stays throw-based like every other module's router-facing
service method.

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
- Gift claim: the row is locked with `SELECT ... FOR UPDATE` at the top of the transaction, then the
  `UPDATE ... WHERE claimed_by IS NULL` runs as a guarded conditional write on top of that lock.
  Self-claim and already-claimed are both rejected against the locked read, before the update.
- Rain recipients are capped by `config.maxRecipients` (default 50) and filtered to exclude the actor
  from the caller-supplied `onlineUserIds` list.
- Gift/rain/donate money movement is fully transactional: debit + credits + system message +
  persisted row(s) happen atomically, in every one of the three commands.
- Money-moving audit rows are written through the same transaction as the debit/credit and the
  system message.
- `mapConcurrent` (limit 10) is used for rain credits - never `Promise.all` on an unbounded
  recipient list.

## Don't

- Keep gift persistence in `player_gift`; do not introduce a second gift table in chat-commands.
- Don't add a DB-backed idempotency table for gift/rain/donate - CACHE/Redis is the single source
  of truth for replay guards here.
- Don't call `CHAT_REALTIME_TRANSPORT.getOnlineUserIds` (or otherwise reach for chat presence) from
  this module - `chat-commands` resolves recipients and passes them into `RAIN_COMMANDS.sendRain`.
- Don't split rain's chat-message write out of its own transaction (eg via a callback owned by
  another module) - `doSendRain` posts the system message and persists the money move atomically,
  the same as `doSendGift`/`doSendDonate`.
