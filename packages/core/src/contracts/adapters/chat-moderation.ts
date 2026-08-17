import { createToken } from './token.js';

export type ChatModerationEntry = {
  id: string;
  userId: string;
  roomId: string | null;
  scope: ChatModerationRoomId;
  reason: string;
  createdAt: string;
  expiresAt: string | null;
};

export type ChatPlatformBan = {
  id: string;
  userId: string;
  reason: string;
  createdAt: string;
  liftedAt: string | null;
  bannedUntil: string | null;
  roomId: string | null;
  scope: ChatModerationRoomId;
};

export type ChatModerationRoomId = string | '__global' | '__all_public' | '__all';

export type ChatModeration = {
  assertCanSend(userId: string, roomId: string | null, isPublic?: boolean): Promise<void>;
  deleteMessage(
    id: string,
    actorId: string,
    meta?: { ip: string | null; userAgent: string | null },
    actorType?: 'admin' | 'player',
  ): Promise<{ success: true }>;
  mute(input: {
    userId: string;
    roomId: ChatModerationRoomId;
    durationSeconds?: number | null;
    reason: string;
    actorId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  unmute(input: {
    userId: string;
    roomId: ChatModerationRoomId;
    actorId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  listMutes(userId?: string): Promise<ChatModerationEntry[]>;
  ban(input: {
    userId: string;
    roomId: ChatModerationRoomId;
    durationSeconds: number | null;
    reason: string;
    actorId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  unban(input: {
    userId: string;
    roomId: ChatModerationRoomId;
    actorId: string;
    ip: string | null;
    userAgent: string | null;
  }): Promise<{ success: true }>;
  listBans(userId?: string): Promise<ChatPlatformBan[]>;
};

export const CHAT_MODERATION = createToken<ChatModeration>('ChatModeration');
