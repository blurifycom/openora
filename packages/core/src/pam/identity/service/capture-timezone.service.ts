import { createLogger } from '@openora/core/server';
import type { PlayerProvisioning, User } from '@openora/core/contracts';

const logger = createLogger('player-timezone');

/**
 * Hands the browser-reported zone to the player module. Every caller invokes this only after
 * the credentials have passed, so an unauthenticated request can never write someone else's
 * row. Best-effort throughout - an absent zone, an unbound port and a failed write are all
 * swallowed, because a cosmetic column must never cost a player their session.
 */
export async function captureTimezone(
  provisioning: PlayerProvisioning | undefined,
  userId: User['id'],
  timezone: string | undefined,
): Promise<void> {
  if (!timezone || !provisioning) {
    return;
  }
  try {
    await provisioning.recordTimezone(userId, timezone);
  } catch (err) {
    logger.warn({ err, userId }, 'player timezone capture failed - ignored');
  }
}
