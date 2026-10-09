import { createToken } from './token.js';
import type { Uuid } from '../schemas/common.js';
import type {
  CHAT_MODERATION_SCOPES,
  CHAT_MODERATION_SCOPE_VALUES,
} from '../schemas/chat-command.js';

export type ChatModerationEntry = {
  id: Uuid;
  userId: Uuid;
  roomId: Uuid | null;
  scope: ChatModerationScope;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
};

export type ChatPlatformBan = {
  id: Uuid;
  userId: Uuid;
  reason: string;
  createdAt: string;
  liftedAt: string | null;
  bannedUntil: string | null;
  roomId: Uuid | null;
  scope: ChatModerationScope;
};

export type ChatModerationRoomId = Uuid | (typeof CHAT_MODERATION_SCOPES)[number];
export type ChatModerationScope = (typeof CHAT_MODERATION_SCOPE_VALUES)[number];

export type ChatModeration = {
  /** Bans and mutes only; room settings (read-only, slow mode) are enforced by the chat send path. */
  assertCanSend(userId: Uuid, roomId: Uuid | null, isPublic?: boolean): Promise<void>;
  deleteMessage(
    id: Uuid,
    actorId: Uuid,
    meta?: { ip: string | null; userAgent: string | null },
    actorType?: 'admin' | 'player',
  ): Promise<{ success: true }>;
  mute(input: {
    userId: Uuid;
    roomId: ChatModerationRoomId;
    durationSeconds?: number | null;
    reason: string;
    actorId: Uuid;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  unmute(input: {
    userId: Uuid;
    roomId: ChatModerationRoomId;
    actorId: Uuid;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  listMutes(userIds?: readonly Uuid[]): Promise<ChatModerationEntry[]>;
  ban(input: {
    userId: Uuid;
    roomId: ChatModerationRoomId;
    durationSeconds: number | null;
    reason: string;
    actorId: Uuid;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  unban(input: {
    userId: Uuid;
    roomId: ChatModerationRoomId;
    actorId: Uuid;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  listBans(userIds?: readonly Uuid[]): Promise<ChatPlatformBan[]>;
};

export const CHAT_MODERATION = createToken<ChatModeration>('ChatModeration');
