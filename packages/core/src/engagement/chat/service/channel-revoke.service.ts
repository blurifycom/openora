import { eq } from 'drizzle-orm';
import { createLogger, type DrizzleDb } from '@openora/core/server';
import {
  GLOBAL_CHAT_ROOM_ID,
  chatChannel,
  type RealtimeTransport,
  type Uuid,
} from '@openora/core/contracts';
import { chatRoom } from '../schema/index.js';

export const ROOM_REVOKE_CONCURRENCY = 10;

const logger = createLogger('chat');

/** Runs after the access change has committed, so a transport failure is logged, never thrown. */
export async function revokeChannelBestEffort(
  transport: RealtimeTransport | undefined,
  userId: Uuid,
  roomId: Uuid | null,
): Promise<void> {
  try {
    await transport?.revokeUserFromChannel?.(userId, chatChannel(roomId));
  } catch (err: unknown) {
    logger.error({ err, roomId, userId }, 'chat room channel revoke failed');
  }
}

/** Revokes the channel a room streams on: the global room streams on `chat:global` under either id. */
export async function revokeRoomChannelBestEffort(
  db: DrizzleDb,
  transport: RealtimeTransport | undefined,
  userId: Uuid,
  roomId: Uuid,
): Promise<void> {
  const [room] = await db
    .select({ slug: chatRoom.slug })
    .from(chatRoom)
    .where(eq(chatRoom.id, roomId))
    .limit(1);
  await revokeChannelBestEffort(
    transport,
    userId,
    room?.slug === GLOBAL_CHAT_ROOM_ID ? null : roomId,
  );
}
