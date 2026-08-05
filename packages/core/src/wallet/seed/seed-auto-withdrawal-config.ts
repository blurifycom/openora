import type { DrizzleDb } from '@openora/core/server';
import { walletAutoWithdrawalConfig } from '../schema/index.js';

/**
 * Idempotently seeds the singleton global auto-withdrawal config row. Zero
 * thresholds reproduce today's "off until a Super Admin configures it"
 * default (see wallet.service.ts's evaluateAutoApproval: a threshold <= 0
 * never auto-approves).
 */
export async function seedAutoWithdrawalConfig(db: DrizzleDb): Promise<void> {
  await db
    .insert(walletAutoWithdrawalConfig)
    .values({ singletonKey: 'global', fiatThreshold: '0', cryptoThreshold: '0' })
    .onConflictDoNothing({ target: walletAutoWithdrawalConfig.singletonKey });
}
