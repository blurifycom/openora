import { createLogger } from '@openora/core/server';
import type { PlayerProvisioning, User } from '@openora/core/contracts';

const logger = createLogger('player-timezone');

export async function captureTimezone(
  provisioning: PlayerProvisioning | undefined,
  userId: User['id'],
  timezone: string | undefined,
): Promise<void> {
  if (!timezone || !provisioning) {
    return;
  }
  try {
    await provisioning.recordTimezone?.(userId, timezone);
  } catch (err) {
    logger.warn({ err, userId }, 'player timezone capture failed - ignored');
  }
}
