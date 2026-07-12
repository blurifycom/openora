import * as z from 'zod';
import { PlayerSchema, MoneyAmountSchema } from '@openora/core/contracts';
import { moneyToNumber } from '@openora/core/server';

const ReKycSnapshotSchema = PlayerSchema.pick({
  currency: true,
  totalDeposits: true,
}).extend({ lastTriggeredDeposits: MoneyAmountSchema });

export type ReKycPlayerSnapshot = z.infer<typeof ReKycSnapshotSchema>;

/**
 * Replaceable strategy deciding when a verified player must re-verify. The default fires
 * once per per-currency threshold band, high-water-marked on the last fire so a
 * re-verified high-roller is not re-triggered on every later deposit. Swapping to a
 * rolling-window or wager metric is a binding change, not a service rewrite.
 */
export type ReKycTrigger = {
  requiresReverify(
    player: ReKycPlayerSnapshot,
    thresholds: Record<string, string> | undefined,
  ): boolean;
};

export class CumulativeDepositReKycTrigger implements ReKycTrigger {
  requiresReverify(player: ReKycPlayerSnapshot, thresholds: Record<string, string> | undefined) {
    const threshold = thresholds?.[player.currency];
    if (threshold === undefined || moneyToNumber(threshold) <= 0) return false;
    // Band-crossing check is a decision, not a ledger write - moneyToNumber is the
    // documented single conversion point.
    const bandSize = moneyToNumber(threshold);
    return (
      Math.floor(moneyToNumber(player.totalDeposits) / bandSize) >
      Math.floor(moneyToNumber(player.lastTriggeredDeposits) / bandSize)
    );
  }
}
