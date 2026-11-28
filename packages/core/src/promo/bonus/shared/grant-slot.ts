import { and, eq } from 'drizzle-orm';
import type { BonusGrantSource, GrantConcurrencyMode } from '@openora/core/contracts';
import { makeConflictError, withAdvisoryXactLock, type DrizzleTx } from '@openora/core/server';
import { promoGrant } from '../schema/index.js';

export const BonusSlotTakenError = makeConflictError(
  'BonusSlotTakenError',
  'Another bonus is already active for this currency; finish or forfeit it first',
  { code: 'BONUS_SLOT_TAKEN' },
);

export type GrantSlot = { userId: string; currency: string; source: BonusGrantSource };

export function withGrantSlotLock<T>(
  tx: DrizzleTx,
  mode: GrantConcurrencyMode,
  userId: string,
  currency: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (mode === 'multiple') {
    return fn();
  }
  return withAdvisoryXactLock(tx, `promo-grant-slot:${userId}:${currency}`, fn);
}

export async function isSlotTaken(
  tx: DrizzleTx,
  mode: GrantConcurrencyMode,
  slot: GrantSlot,
): Promise<boolean> {
  if (mode === 'multiple') {
    return false;
  }
  const [row] = await tx
    .select({ id: promoGrant.id })
    .from(promoGrant)
    .where(
      and(
        eq(promoGrant.userId, slot.userId),
        eq(promoGrant.currency, slot.currency),
        eq(promoGrant.status, 'active'),
        mode === 'per_source' ? eq(promoGrant.source, slot.source) : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
}
