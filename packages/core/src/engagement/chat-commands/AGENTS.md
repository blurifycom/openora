# chat-commands

Player-facing slash commands (`/gift`, `/rain`) and `@mention` for the chat UI, plus the `listCommands` catalog descriptor. This module owns none of the money/limit/idempotency logic for gift/rain - `social-transfers` does, behind the `GIFT_COMMANDS`/`RAIN_COMMANDS` ports. `/donate` is social-transfers' own oRPC operation entirely (not reachable through this module).

## DB-backed command registry (read-only now)

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb column (`maxAmount`, `minAmount`, `maxRecipients`) - seeded via `seed/index.ts` (`seedChatCommands`). `listCommands` reads this table for the catalog descriptor only. There is no longer an admin route to mutate it (the old `adminUpdateCommand` was removed with this module's other money/search operations) - social-transfers reads the SAME table (via its `/schema` subpath, cross-module read-only) to gate and limit-check `/gift`, `/rain`, `/donate`.

`mention` is special: it does not go through a POST route. The `@username` pattern is typed inline in a message; `GET /chat-command/mention-search` powers the type-ahead. `searchMentions` takes a `viewerId` and excludes any player the caller has blocked or ignored via `CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)`.

## `roomId` on `/gift` and `/rain` accepts a room UUID or the GLOBAL_CHAT_ROOM_ID sentinel

`PostGiftInputSchema`/`PostRainInputSchema` type `roomId` as `ChatRoomIdSchema`
(`@openora/core/contracts`, backed by `contracts/schemas/chat-command.ts`) - a real room UUID or the
literal `GLOBAL_CHAT_ROOM_ID` (`'__global'`). There is no raw-`null` wire form; the schema's
`.transform()` normalizes the sentinel to `null` before `postGift`/`postRain` ever run, so both
handlers just forward `input.roomId: Uuid | null` straight into the `GIFT_COMMANDS`/`RAIN_COMMANDS`
ports unchanged - social-transfers owns what `null` means (global chat). `postRain`'s presence
lookup already worked with `roomId: null` before this (`chatChannel(null)` resolves to
`chat:global`), so no change was needed there beyond the type.

## postGift / claimGift / postRain are pure delegation - zero money/limit/chat-write business logic here

`postGift` (`POST /chat-command/gift`), `claimGift` (`POST /chat-command/gift/{id}/claim`), and
`postRain` (`POST /chat-command/rain`) resolve the `GIFT_COMMANDS`/`RAIN_COMMANDS` ports (bound by
`social-transfers`) and forward the call - no config checks, no idempotency, no wallet calls, no
chat-message posting, no DB writes happen in this module for any of the three. `GIFT_COMMANDS.sendGift`/`claimGift`
and `RAIN_COMMANDS.sendRain` return a discriminated result (`{ ok: true, ... } | { ok: false, reason }`)
rather than throwing, because a thrown error class from another module can't be `instanceof`-matched
by this module's router (`mapErrors`) without a cross-module internals import, which the boundary
rules forbid. `ChatCommandsService.postGift`/`claimGift`/`postRain` translate `reason` into this
module's own typed errors (`CommandDisabledError`, `InsufficientBalanceError`, etc. - the SAME error
class identities the router's `mapErrors` checks), so the router logic stays the standard
`mapErrors` pattern.

## This module owns presence for `/rain` - nothing else

`postRain` (`POST /chat-command/rain`) resolves who is online in the room via
`CHAT_REALTIME_TRANSPORT.getOnlineUserIds(chatChannel(roomId))` and passes the plain
`onlineUserIds` list into `RAIN_COMMANDS.sendRain(input, actorId)` - that is its entire
responsibility. `social-transfers` posts and publishes rain's system message itself, inside its
own money-moving transaction, exactly like `/gift` and `/donate` - `postRain` never touches
`CHAT_SYSTEM_WRITER` or `CHAT_REALTIME_TRANSPORT.publish`.

This split (presence resolved here, everything else in `social-transfers`) exists because
`chat-commands` already depends on `social-transfers` (for `GIFT_COMMANDS`) - a reverse dependency
from `social-transfers` back onto `chat-commands`, or onto `chat`'s `CHAT_REALTIME_TRANSPORT.getOnlineUserIds`
specifically for presence, would create an import cycle the plugin loader's topological sort cannot
resolve. Presence is the ONLY piece that needed to move to the caller for that reason - the actual
chat write stays inside `social-transfers`' transaction because it must commit or roll back
atomically with the wallet move, and `social-transfers` has no way to receive a `tx` handle from a
caller that doesn't hold it.

## Ports consumed

- `ADMIN_USER_DIRECTORY` - `findPlayerIds`/`lookupPlayers` for `mentionSearch`.
- `CHAT_BLOCK_WRITER` - `getExcludedUserIds` to keep blocked/ignored players out of `@mention` autocomplete.
- `CHAT_REALTIME_TRANSPORT` - `getOnlineUserIds(channel)` for `/rain` recipient discovery. The chat-scoped token, not the generic `REALTIME_TRANSPORT`.
- `GIFT_COMMANDS` / `RAIN_COMMANDS` - `sendGift`/`claimGift`/`sendRain`, bound by `social-transfers`. Declared via `dependsOn: ['chat', 'social-transfers']`.

## What moved to social-transfers (and why)

`execute` (the gift/rain/donate/block/ignore discriminated union), `getGift`, `adminUpdateCommand`, `playerSearch`, `playerProfile` were removed from this module entirely:

- Gift/rain/donate money movement, limit checks, and idempotency -> `social-transfers` (`packages/core/src/engagement/social-transfers/`). See that module's AGENTS.md for the idempotency/publish-after-commit/rain-remainder/exact-username invariants - they did not change, only moved.
- `block`/`ignore` (and their `unblock`/`unignore` counterparts) were pure duplication of `chat.blockUser`/`chat.unblockUser`/`chat.ignoreUser`/`chat.unignoreUser` (backed by the same `CHAT_BLOCK_WRITER`) - deleted outright, not moved. Consumers call the `chat` module's operations directly. `block`/`unblock`/`ignore`/`unignore` still exist as `CHAT_COMMAND_TYPES` catalog entries (`listCommands`) and `CommandMetadataSchema` union members purely for command-palette discovery and wire-shape symmetry - this module never executes them and never posts a system message for any of the four.
- `playerSearch`/`playerProfile` -> `player-management` (`playerSearch`/`playerProfile` on `playerContract`), since they are player-directory lookups, not chat commands.
- The old `chat_gift` table and its migration are left untouched here (no new writes target it) - see `social-transfers/AGENTS.md` for the successor `player_gift` table and the deliberately-deferred migration decision for it.

## Extension points

Add a new NON-money command type by:

1. Adding the key to `CHAT_COMMAND_TYPES` in `contract/index.ts`.
2. Inserting a seed row in `seed/index.ts`.
3. Adding the route + handler here if it's a chat-command-owned lookup (like `mentionSearch`), or in the owning module if it needs money/limits (follow the `social-transfers` pattern via a dedicated command port).
