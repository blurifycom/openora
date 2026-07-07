import * as z from 'zod';
import { PlayerSchema } from '@blurifycom/core/contracts';

const ReKycSnapshotSchema = PlayerSchema.pick({
  currency: true,
  totalDeposits: true,
}).extend({ lastTriggeredDeposits: z.number() });

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
    thresholds: Record<string, number> | undefined,
  ): boolean;
};

export class CumulativeDepositReKycTrigger implements ReKycTrigger {
  requiresReverify(player: ReKycPlayerSnapshot, thresholds: Record<string, number> | undefined) {
    const threshold = thresholds?.[player.currency];
    if (threshold === undefined || threshold <= 0) return false;
    return (
      Math.floor(player.totalDeposits / threshold) >
      Math.floor(player.lastTriggeredDeposits / threshold)
    );
  }
}
