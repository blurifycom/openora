import type { ChatContextRoomCommands } from '@openora/core/contracts';
import type { DrizzleService, EventBus } from '@openora/core/server';
import type { ContextRoomCommand } from './chat-context-room-command.service.js';

const NOTHING_AFTER_COMMIT = { afterCommit: async () => {} };

export class OutboxChatContextRoomCommands implements ChatContextRoomCommands {
  constructor(
    private readonly events: EventBus,
    private readonly drizzle: DrizzleService,
  ) {}

  ensureRoom({
    tx,
    ref,
    roomId,
    name,
    memberIds,
  }: Parameters<ChatContextRoomCommands['ensureRoom']>[0]) {
    return this.issue(tx, { op: 'ensure', ref, roomId, name, memberIds });
  }

  close({ tx, ref }: Parameters<ChatContextRoomCommands['close']>[0]) {
    return this.issue(tx, { op: 'close', ref });
  }

  postSystemEvent({
    tx,
    ref,
    messageId,
    code,
    params = {},
  }: Parameters<ChatContextRoomCommands['postSystemEvent']>[0]) {
    return this.issue(tx, {
      op: 'post_system_event',
      ref,
      messageId,
      metadata: { command: 'system_event', code, params },
    });
  }

  private async issue(tx: unknown, command: ContextRoomCommand) {
    await (tx === undefined
      ? this.drizzle.db.transaction((t) => this.emit(t, command))
      : this.emit(tx, command));
    return NOTHING_AFTER_COMMIT;
  }

  private emit(tx: unknown, command: ContextRoomCommand): Promise<void> {
    return this.events.emitInTransaction(tx, 'chat.context_room.command_issued', command);
  }
}
