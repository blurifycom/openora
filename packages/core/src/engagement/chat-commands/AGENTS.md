# chat-commands

Thin chat-command surface: the DB-backed command registry (`chat_command_config`) and `@mention`
autocomplete. This module never touches a wallet and never opens a `db.transaction` for money.

`gift`, `rain` and `donate` appear in `CHAT_COMMAND_TYPES` as _registry keys only_. Core owns the
configuration surface for them - whether they are enabled, their label, their per-currency limits -
and owns none of the mechanics. An operator that wants player-to-player transfers implements them
in its own overlay extension, reading this module's `chat_command_config` row through the
sanctioned read-only `/schema` subpath. Do not add the money movement back here (see "Don't").

## DB-backed command registry

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb
column (`maxAmount`, `minAmount`, `maxRecipients`). `maxAmount`/`minAmount` are keyed by currency
ticker (`Record<string, MoneyAmount>`, eg `{ USD: '1.00000000' }`), not a single flat amount - a
minimum sensible in USD is meaningless or absurd in BTC, so one constant cannot be correct across
every currency. A currency with no entry has no limit enforced for it: an operator opts a currency
INTO a limit rather than inheriting one meant for a different currency.

An overlay that enforces these limits must read them through `CommandConfigSchema.safeParse`, never
through Drizzle's `$type<CommandConfig>()` alone - the column is not runtime-checked, and a row
written before `minAmount`/`maxAmount` became per-currency maps still holds a flat string. Indexing
a string by a currency key returns `undefined`, which reads as "no limit configured" and silently
degrades a real-money spend limit to unlimited.

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
