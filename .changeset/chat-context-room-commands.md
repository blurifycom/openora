---
'@openora/core': minor
---

A service that does not run chat can now write to chat through the transactional outbox instead of a chat service call, so its own commit never waits on, or fails because of, a chat write.

New optional `CHAT_CONTEXT_ROOM_COMMANDS` port, and the `OutboxChatContextRoomCommands` binding for it. A module that owns a context room (a match, a table) asks chat to ensure it, close it or post a system event in it, in the same transaction as its own state change. The commands travel as the new `chat.context_room.command_issued` event, and chat applies each keyed on the caller's ids (`roomId` for the room, `messageId` for a post), so a redelivery changes nothing. Commands are not applied in issue order: one chat cannot apply yet, such as a post for a room that has no ensure applied, is redelivered and dead-lettered after its last delivery. `ensureRoom` takes an optional `roomId` so a caller can name the room it creates.

`ChatSystemWriter` gains an outbox binding, `OutboxChatSystemWriter`, that writes the new `chat.system_message.upserted` event. A system card is keyed on the caller's `messageId` and carries a `version` (`CHAT_SYSTEM_MESSAGE_VERSION`), so a late or redelivered post never reverts a settled card. `chat_message` gains the `version` column.

New `CHAT_TRANSFER_CHECK` port with `checkChatTransfer`, and `CHAT_BLOCK_READER`. The transfer check reads every chat-side fact a money transfer rests on (command enabled, actor may post, send policy, blocks with the counterparts) in one call on the caller's transaction, and fails closed with `chat_unavailable` when chat cannot answer. A transfer is also refused when the command limits cannot be read. A `context_send_denied` verdict carries the room's `contextRef`, so a caller can apply its own per-context rule before the policy's reason.

Block and friendship events are published through the outbox, in emit order.

`ChatBlockWriter` and `CHAT_BLOCK_READER` gain `getBlockerIds(userId)`: the ids of the users holding an active block on `userId`. Ignores are not included. A partial index on `chat_user_block (blocked_id) WHERE removed_at IS NULL` backs the lookup.

`event_outbox` gains a nullable `seq` column filled from a new sequence, and the relay claims `ORDER BY occurred_at, seq NULLS FIRST`, so events written in the same millisecond are published in insert order. `occurredAt` stays the wall-clock time of the emit. The column and its default are added without rewriting the table, so a deploy does not stall inserts. Rows written before the deploy keep a null `seq` and sort first.

**Breaking:** `ChatBlockWriter` gains the required `getBlockerIds`. A custom `CHAT_BLOCK_WRITER` binding has to implement it.

**Breaking:** ensuring a closed context room adds nobody: it returns the room as it is and no longer adds the members it is given. Kept at `minor` per the pre-1.0 convention that breaking changes ship in a minor with a callout.

Migrations: chat `0022` adds `chat_message.version`, chat `0023` adds `chat_user_block_blocked_idx`, outbox `0004` adds the `event_outbox_seq` sequence and a nullable `event_outbox.seq`, outbox `0005` sets the column default to the sequence.
