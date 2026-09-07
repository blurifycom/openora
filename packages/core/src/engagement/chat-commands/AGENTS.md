# chat-commands

Thin chat-command surface: the DB-backed command registry (`chat_command_config`) and `@mention`
autocomplete. This module never touches a wallet and never opens a `db.transaction` for money.

`gift`, `rain` and `donate` appear in `CHAT_COMMAND_TYPES` as _registry keys only_. Core owns the
configuration surface for them - whether they are enabled, their label, their limits - and owns
none of the mechanics. An operator that wants player-to-player transfers implements them
in its own overlay extension, reading this module's `chat_command_config` row through the
sanctioned read-only `/schema` subpath. Do not add the money movement back here (see "Don't").

## DB-backed command registry

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb
column (`maxAmount`, `minAmount`, `maxRecipients`). `maxAmount`/`minAmount` are a single
`{ currency, amount }` pair (eg `{ currency: 'USD', amount: '1.00000000' }`), the way a
responsible-gambling limit is stated: the operator sets one amount in one currency, and an overlay
converts a transfer denominated in any other currency into that currency when it checks the limit.
A per-currency map would leave any currency without an entry unlimited, so a BTC minimum could be
walked around by sending ETH. Converting only ever decides whether a transfer is allowed - the
funds themselves are never converted, and the recipient is credited in the sender's currency.

An overlay that enforces these limits must read them through `CommandConfigSchema.safeParse`, never
through Drizzle's `$type<CommandConfig>()` alone - the column is not runtime-checked, and a row an
older deployment wrote can still hold an older shape. It must also fail the transfer closed when no
exchange rate is available, and record the rate and its timestamp with the decision.

`listCommands` filters to `enabled: true` by default. Seed data lives in `seed/index.ts`
(`seedChatCommands`). `adminListCommands` (`GET /backoffice/chat-command/commands`, paginated, all
rows including disabled) and `adminUpdateCommand` (`PATCH /backoffice/chat-command/commands/{key}`,
upserts by `key`) cover backoffice toggling and reconfiguration - both are `AdminGuard`-gated on the
`chat-command` resource (`view`/`update`), and `adminUpdateCommand` records a `chat.command.updated`
audit entry via `AUDIT_WRITER`.

## Mention autocomplete

`mention` does not go through a dedicated post route. The `@username` pattern is typed inline in a
message; `GET /chat-command/mention-search` powers the type-ahead, excluding any player the caller
has blocked or ignored via `CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)`.

## Ports consumed

- `ADMIN_USER_DIRECTORY` - `findPlayerIds`/`lookupPlayers` for `@mention` autocomplete.
- `CHAT_BLOCK_WRITER` - `getExcludedUserIds(viewerId)` to filter blocked and ignored players out of
  mention search.
- `AUDIT_WRITER` - `record(...)` for `adminUpdateCommand`'s `chat.command.updated` audit entry.

## Don't

- Don't add money movement, wallet access, limit enforcement or idempotency here. Player-to-player
  transfers are operator-specific and belong in an overlay extension, not in the public platform.
  This module stays a registry and a search endpoint.
- Don't widen `CommandConfigSchema` to carry operator-specific mechanics. It describes limits a
  command may be configured with, not how any command behaves.
