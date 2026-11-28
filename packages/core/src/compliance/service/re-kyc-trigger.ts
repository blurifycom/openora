import * as z from 'zod';
import { PlayerSchema, MoneyAmountSchema } from '@openora/core/contracts';
import { moneyCompare, moneyDivide, moneyFloorToScale } from '@openora/core/server';

const ReKycSnapshotSchema = PlayerSchema.pick({
  currency: true,
  totalDeposits: true,
}).extend({ lastTriggeredDeposits: MoneyAmountSchema });

export type ReKycPlayerSnapshot = z.infer<typeof ReKycSnapshotSchema>;

export type ReKycTrigger = {
  requiresReverify(
    player: ReKycPlayerSnapshot,
    thresholds: Record<string, string> | undefined,
  ): boolean;
};

export class CumulativeDepositReKycTrigger implements ReKycTrigger {
  requiresReverify(player: ReKycPlayerSnapshot, thresholds: Record<string, string> | undefined) {
    const threshold = thresholds?.[player.currency];
    if (threshold === undefined || moneyCompare(threshold, '0') <= 0) {
      return false;
    }
    const band = (amount: string) => moneyFloorToScale(moneyDivide(amount, threshold), 0);
    return moneyCompare(band(player.totalDeposits), band(player.lastTriggeredDeposits)) > 0;
  }
}
