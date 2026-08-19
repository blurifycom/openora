import type {
  AuditWritePort,
  ChatModeration,
  ClientMeta,
  RealtimeTransport,
  Uuid,
} from '@openora/core/contracts';
import type { ChatMessage } from '../contract/index.js';
import { ChatBanService } from './chat-ban.service.js';
import { ChatMessageModerationService } from './chat-message-moderation.service.js';
import { ChatMuteService } from './chat-mute.service.js';
export * from './errors/chat-moderation.errors.js';
export { ChatMessageNotFoundError } from './chat-message-moderation.service.js';
import { DrizzleService } from '@openora/core/server';

export class ChatModerationService implements ChatModeration {
  private readonly messages: ChatMessageModerationService;
  private readonly mutes: ChatMuteService;
  private readonly bans: ChatBanService;

  constructor(drizzle: DrizzleService, transport: RealtimeTransport, audit: AuditWritePort) {
    this.messages = new ChatMessageModerationService(drizzle, transport, audit);
    this.mutes = new ChatMuteService(drizzle, audit);
    this.bans = new ChatBanService(drizzle, audit, transport);
  }

  assertCanSend(userId: Uuid, roomId: Uuid | null, isPublic = true) {
    return this.mutes.assertCanSend(userId, roomId, isPublic);
  }

  deleteMessage(
    id: ChatMessage['id'],
    actorId: Uuid,
    meta?: ClientMeta,
    actorType: 'admin' | 'player' = 'admin',
  ) {
    return this.messages.deleteMessage(id, actorId, meta, actorType);
  }

  mute(input: Parameters<ChatModeration['mute']>[0]) {
    return this.mutes.mute({ ...input, durationSeconds: input.durationSeconds ?? null });
  }

  unmute(input: Parameters<ChatModeration['unmute']>[0]) {
    return this.mutes.unmute(input);
  }

  listMutes(userId?: Uuid) {
    return this.mutes.listMutes(userId);
  }

  ban(input: Parameters<ChatModeration['ban']>[0]) {
    return this.bans.ban({ ...input, durationSeconds: input.durationSeconds ?? null });
  }

  unban(input: Parameters<ChatModeration['unban']>[0]) {
    return this.bans.unban(input);
  }

  listBans(userId?: Uuid) {
    return this.bans.listBans(userId);
  }
}
