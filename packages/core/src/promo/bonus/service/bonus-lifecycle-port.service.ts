import type { BonusForfeitOutcome, BonusLifecycleCommands } from '@openora/core/contracts';
import {
  GrantLifecycleService,
  GrantNotFoundError,
  GrantNotForfeitableError,
} from './grant-lifecycle.service.js';

/**
 * Adapts `GrantLifecycleService.forfeit` (throws on refusal) to the BONUS_LIFECYCLE command port
 * shape (returns an outcome). The service itself emits `promo.bonus.forfeited`, so a job-driven
 * forfeit gets the same realtime balance signal and player notification as any other.
 */
export function createBonusLifecyclePort(service: GrantLifecycleService): BonusLifecycleCommands {
  return {
    async forfeit(grantId, reason, note): Promise<BonusForfeitOutcome> {
      try {
        const closed = await service.forfeit({ grantId, reason, note });
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
