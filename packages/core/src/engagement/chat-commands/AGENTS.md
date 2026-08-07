# chat-commands

Thin chat-command routing surface: the DB-backed command registry (`chat_command_config`),
`@mention` autocomplete, and dedicated `postGift`/`claimGift`/`getGift`/`postRain` routes. All
gift/rain/donate money movement, limit checks, and idempotency live in `social-transfers` behind
the `GIFT_COMMANDS`/`RAIN_COMMANDS` command ports (ADR-0017) - this module never touches a wallet
or opens a `db.transaction` for money. See `social-transfers/AGENTS.md` for the mechanics; this
file only covers what actually lives here.

## DB-backed command registry

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb
column (`maxAmount`, `minAmount`, `maxRecipients`) - the same row `social-transfers` reads
read-only via the sanctioned cross-module `/schema` import (`db-conventions`/`clean-architecture`).
`listCommands` filters to `enabled: true` by default. Seed data lives in `seed/index.ts`
(`seedChatCommands`). `adminListCommands` (`GET /backoffice/chat-command/commands`, paginated, all
rows including disabled) and `adminUpdateCommand` (`PATCH /backoffice/chat-command/commands/{key}`,
upserts by `key`) cover backoffice toggling/reconfiguration - both are `AdminGuard`-gated on the
`chat-command` resource (`view`/`update`) and `adminUpdateCommand` records a
`chat.command.updated` audit entry via `AUDIT_WRITER`.

`mention` is special: it does not go through a dedicated post route. The `@username` pattern is
typed inline in a message; `GET /chat-command/mention-search` powers the type-ahead, excluding any
player the caller has blocked or ignored via `CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)`.

## Gift/rain routes are pure delegation to social-transfers

`postGift`, `claimGift`, `getGift`, and `postRain` all call straight into the `GIFT_COMMANDS`/
`RAIN_COMMANDS` port (bound by `social-transfers`) and translate the port's discriminated
`{ ok, reason }` result into this module's own typed errors (`GiftNotFoundError`,
`ChatRoomNotMemberError`, etc.), which the router then maps to transport codes via `mapErrors`.
`getGift` (`GET /chat-command/gift/{id}`) is the read-only counterpart to `claimGift` - it returns
the gift's current state (claimed/unclaimed, claimed-by-whom) without moving money, and enforces
the exact same room-membership check as `claimGift`: a viewer who isn't a member of the gift's room
gets `ChatRoomNotMemberError`, not the gift state. Like every other route on this router, it
requires auth - the caller resolves `viewerId` via `getUserId(context)`, there is no
unauthenticated read path.

`postRain` is the one route that does real work here beyond translation: it resolves the online
recipient list via `CHAT_REALTIME_TRANSPORT.getOnlineUserIds(chatChannel(roomId))` (this module
owns presence for the whole chat-command surface) BEFORE calling `RAIN_COMMANDS.sendRain` - see
`social-transfers/AGENTS.md` > "This module never queries chat's presence tracking" for why that
split exists.

## Ports consumed

- `ADMIN_USER_DIRECTORY` - `findPlayerIds`/`lookupPlayers` for `@mention` autocomplete.
- `CHAT_BLOCK_WRITER` - `getExcludedUserIds(viewerId)` to filter blocked/ignored players out of
  mention search.
- `GIFT_COMMANDS` / `RAIN_COMMANDS` - bound by `social-transfers`; this module never implements
  gift/rain mechanics itself.
- `CHAT_REALTIME_TRANSPORT` - `getOnlineUserIds(channel)` for rain recipient discovery. The
  chat-scoped token, not the generic `REALTIME_TRANSPORT`.
- `AUDIT_WRITER` - `record(...)` for `adminUpdateCommand`'s `chat.command.updated` audit entry.

## Don't

- Don't add money-movement logic here - every gift/rain code path is a pure port delegation into
  `social-transfers`; a new business rule for gift/rain belongs there, not in this service.
- Don't have `getGift` (or any route here) skip the room-membership check that `claimGift` enforces
  - the two must stay symmetric so a client can't infer gift state it isn't allowed to see.
