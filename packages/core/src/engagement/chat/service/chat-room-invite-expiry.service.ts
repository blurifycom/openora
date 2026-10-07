import { and, eq, or, type SQL } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx, EventBus } from '@openora/core/server';
import type { ClientMeta, Uuid } from '@openora/core/contracts';
import { chatRoomInvite } from '../schema/index.js';

export type ExpiredInvite = { id: Uuid; roomId: Uuid; inviterId: Uuid; inviteeId: Uuid };

export type InviteExpiryMeta = Partial<ClientMeta> & {
  actorId?: Uuid;
  actorPlayerId?: Uuid | null;
};

export function expirePendingInvites(
  db: DrizzleDb | DrizzleTx,
  condition: SQL | undefined,
): Promise<ExpiredInvite[]> {
  return db
    .update(chatRoomInvite)
    .set({ status: 'expired' })
    .where(and(eq(chatRoomInvite.status, 'pending'), condition))
    .returning({
      id: chatRoomInvite.id,
      roomId: chatRoomInvite.roomId,
      inviterId: chatRoomInvite.inviterId,
      inviteeId: chatRoomInvite.inviteeId,
    });
}

export function expireInvitesSentBy(db: DrizzleDb | DrizzleTx, roomId: Uuid, inviterId: Uuid) {
  return expirePendingInvites(
    db,
    and(eq(chatRoomInvite.roomId, roomId), eq(chatRoomInvite.inviterId, inviterId)),
  );
}

export function expireInvitesInvolving(db: DrizzleDb | DrizzleTx, userId: Uuid, roomId?: Uuid) {
  return expirePendingInvites(
    db,
    and(
      roomId ? eq(chatRoomInvite.roomId, roomId) : undefined,
      or(eq(chatRoomInvite.inviterId, userId), eq(chatRoomInvite.inviteeId, userId)),
    ),
  );
}

export function emitExpiredInvites(
  events: EventBus,
  expired: ExpiredInvite[],
  { actorId, actorPlayerId, ip, userAgent }: InviteExpiryMeta = {},
) {
  for (const row of expired) {
    events.emit('chat.room.invite.expired', {
      inviteId: row.id,
      roomId: row.roomId,
      inviterId: row.inviterId,
      inviteeId: row.inviteeId,
      ...(actorId ? { actorId, actorPlayerId: actorPlayerId ?? null } : {}),
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }
}
