import { createLogger } from '@openora/core/server';
import { chatChannel, type RealtimeTransport, type Uuid } from '@openora/core/contracts';

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
