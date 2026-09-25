import type { BonusForfeitOutcome, BonusLifecycleCommands } from '@openora/core/contracts';
import type { EventBus } from '@openora/core/server';
import {
  GrantLifecycleService,
  GrantNotFoundError,
  GrantNotForfeitableError,
} from './grant-lifecycle.service.js';

/**
 * Adapts `GrantLifecycleService.forfeit` (throws on refusal) to the BONUS_LIFECYCLE command port
 * shape (returns an outcome) and announces the same `promo.bonus.forfeited` topic a router- or
 * rule-driven forfeit already emits, so a job-driven one gets the same realtime balance signal
 * and player notification for free rather than a second announcement path to keep in sync.
 */
export function createBonusLifecyclePort(
  service: GrantLifecycleService,
  bus: EventBus,
): BonusLifecycleCommands {
  return {
    async forfeit(grantId, reason, note): Promise<BonusForfeitOutcome> {
      try {
        const closed = await service.forfeit(grantId, reason, undefined, note);
        bus.emit('promo.bonus.forfeited', {
          userId: closed.userId,
          grantId: closed.grantId,
          currency: closed.currency,
          forfeitedAmount: closed.forfeitedAmount,
          reason,
          actorId: null,
        });
        return {
          ok: true,
          grantId: closed.grantId,
          userId: closed.userId,
          currency: closed.currency,
          forfeitedAmount: closed.forfeitedAmount,
        };
      } catch (err) {
        if (err instanceof GrantNotFoundError) {
          return { ok: false, reason: 'not_found' };
        }
        if (err instanceof GrantNotForfeitableError) {
          return { ok: false, reason: 'not_forfeitable' };
        }
        throw err;
      }
    },
  };
}
