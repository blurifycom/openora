# chat-commands

Chat-command surface: the DB-backed command registry (`chat_command_config`), `@mention`
autocomplete, and generic command routing. Money-moving implementations for donate, gift, and
rain are supplied by downstream overlays through the `GIFT_COMMANDS` and `RAIN_COMMANDS` ports;
this module does not own their persistence, wallet mutations, claims, recipient selection,
idempotency, audit writes, or realtime publishing.

## DB-backed command registry

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb
column (`maxAmount`, `minAmount`, `maxRecipients`). The downstream transfer overlay reads this
existing configuration through its composition root.
`listCommands` filters to `enabled: true` by default. Seed data lives in `seed/index.ts`
(`seedChatCommands`). `adminListCommands` (`GET /backoffice/chat-command/commands`, paginated, all
rows including disabled) and `adminUpdateCommand` (`PATCH /backoffice/chat-command/commands/{key}`,
upserts by `key`) cover backoffice toggling/reconfiguration - both are `AdminGuard`-gated on the
`chat-command` resource (`view`/`update`) and `adminUpdateCommand` records a
`chat.command.updated` audit entry via `AUDIT_WRITER`.

`mention` is special: it does not go through a dedicated post route. The `@username` pattern is
typed inline in a message; `GET /chat-command/mention-search` powers the type-ahead, excluding any
player the caller has blocked or ignored via `CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)`.

## Transfer routes

`postGift`, `claimGift`, `getGift`, and `postRain` call downstream implementations through the
`GIFT_COMMANDS`/`RAIN_COMMANDS` ports and translate the port's discriminated
`{ ok, reason }` result into this module's own typed errors (`GiftNotFoundError`,
`ChatRoomNotMemberError`, etc.), which the router then maps to transport codes via `mapErrors`.
`getGift` (`GET /chat-command/gift/{id}`) is the read-only counterpart to `claimGift` - it returns
the gift's current state (claimed/unclaimed, claimed-by-whom) without moving money, and enforces
the exact same room-membership check as `claimGift`: a viewer who isn't a member of the gift's room
gets `ChatRoomNotMemberError`, not the gift state. Like every other route on this router, it
requires auth - the caller resolves `viewerId` via `getUserId(context)`, there is no
unauthenticated read path.

`postRain` resolves the online recipient list via
`CHAT_REALTIME_TRANSPORT.getOnlineUserIds(chatChannel(roomId))` (this module owns presence for
the whole chat-command surface) before calling `RAIN_COMMANDS.sendRain`.

## Ports consumed

- `ADMIN_USER_DIRECTORY` - `findPlayerIds`/`lookupPlayers` for `@mention` autocomplete.
- `CHAT_BLOCK_WRITER` - `getExcludedUserIds(viewerId)` to filter blocked/ignored players out of
  mention search.
- `GIFT_COMMANDS` / `RAIN_COMMANDS` - required from the downstream transfer overlay.
- `CHAT_REALTIME_TRANSPORT` - `getOnlineUserIds(channel)` for rain recipient discovery. The
  chat-scoped token, not the generic `REALTIME_TRANSPORT`.
- `AUDIT_WRITER` - `record(...)` for `adminUpdateCommand`'s `chat.command.updated` audit entry.

## Don't

- Add concrete transfer, wallet, persistence, claim-locking, recipient-selection, idempotency,
  audit, or realtime implementation here.
- Change the public command routes or port failure-reason translation.
