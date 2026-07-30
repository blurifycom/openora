# chat-commands

Player-facing slash commands (`/profile`, `/gift`, `/rain`) and `@mention` for the chat UI. Commands are stored in `chat_command_config` keyed by command type; operators can toggle or reconfigure any command via `adminUpdateCommand` without a deploy.

## DB-backed command registry

Each row in `chat_command_config` holds `enabled`, `label`, `description`, and a `config` jsonb column (`maxAmount`, `minAmount`, `maxRecipients`). The service checks the row before dispatching — a missing or disabled row throws `CommandDisabledError` (404). Seed data lives in `seed/index.ts` (`seedChatCommands`), called from `tools/db/seed.ts`. Four default commands: `mention`, `profile`, `gift`, `rain`.

`mention` is special: it does not go through `POST /chat-command/execute`. The `@username` pattern is typed inline in a message; `GET /chat-command/mention-search` powers the type-ahead. The registry entry exists so operators can disable @mentions platform-wide.

`profile` is also special like `mention` - it does not go through `POST /chat-command/execute`; `GET /chat-command/player-search` powers the search step and `GET /chat-command/player-profile/{userId}` (lookup by userId only, never username) returns the full profile card. Neither route posts to chat.

`/block` and `/ignore` write to separate tables (`chatUserBlock` vs `chatUserIgnore`, owned by `chat`) via `CHAT_BLOCK_WRITER.blockUser`/`ignoreUser` respectively - they used to both call `blockUser`, now `handleBlockAction` dispatches on `input.type`. Both self-actions (blocking/ignoring yourself) are rejected via `SelfModerationActionError` (409), checked after the target username resolves. `searchPlayers`/`searchMentions` both take a `viewerId` and exclude any player the caller has blocked or ignored via `CHAT_BLOCK_WRITER.getExcludedUserIds(viewerId)` - a blocked/ignored player will not surface in player search or @mention autocomplete.

## Claimable gift mechanic

`/gift <amount>` is a two-step flow: the sender is debited immediately and a `chat_gift` row (status: unclaimed) is created atomically with the system message. Any other player calls `POST /chat-command/gift/:id/claim` to win the credit. The atomic claim uses `UPDATE ... WHERE claimed_by IS NULL RETURNING *` — first caller wins, zero balance goes unreturned. Realtime push fires on claim via `CHAT_REALTIME_TRANSPORT.publish(chatChannel(roomId), ...)` so frontends can update the card live.

`chatGift.messageId` is a plain UUID with no FK — cross-module boundary rule applies.

## Ports consumed

- `CHAT_SYSTEM_WRITER` — posts system messages into the chat stream (bound by the `chat` plugin; implemented by `ChatService.sendSystemMessage`).
- `WALLET_COMMANDS` — debits the actor and credits recipient(s) within a single transaction; money never flows over events.
- `ADMIN_USER_DIRECTORY` — `findPlayerIds` for username search, `lookupPlayers` for batch profile resolution.
- `ADMIN_GAME_REPORTING` — `getPlayerStats` for total-wagered/total-bets on the profile card (owned by casino/gaming).
- `AUDIT_WRITER` — direct `record()` after each gift send and gift claim for the regulatory trail.
- `CHAT_REALTIME_TRANSPORT` — `getOnlineUserIds(channel)` for rain recipient discovery; `publish(channel, event)` for gift-claimed push. The chat-scoped token, not the generic `REALTIME_TRANSPORT` - this module publishes on the same `chat:*` channels chat itself uses, so it must ride whatever transport chat is bound to (see `chat/AGENTS.md`), never a different one.

## Extension points

Add a new command type by:

1. Adding the key to `CHAT_COMMAND_TYPES` in `contract/index.ts`.
2. Adding a handler method in `ChatCommandsService`.
3. Adding a dispatch branch in `executeCommand`.
4. Inserting a seed row in `tools/db/seed.ts`.

## Invariants

- Gift send: debit + `chatGift` insert + system message are atomic in one transaction. `messageId` is back-filled in the same transaction after `postSystemMessage` returns.
- Gift claim: the `UPDATE ... WHERE claimed_by IS NULL` is the idempotency guard — no separate lock needed. Self-claim is rejected before the update attempt.
- Rain recipients are capped by `config.maxRecipients` (default 50) and filtered to exclude the actor.
- All money movement is transactional: debit + credits + system message happen atomically.
- `mapConcurrent` (limit 10) is used for rain credits — never `Promise.all` on an unbounded recipient list.
- `adminUpdateCommand` uses an upsert so a missing config row is created on first admin call.
