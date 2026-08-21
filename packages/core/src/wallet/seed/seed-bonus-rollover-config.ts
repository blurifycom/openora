import type { DrizzleDb } from '@openora/core/server';
import { walletBonusRolloverConfig } from '../schema/index.js';

/**
 * Idempotently seeds the singleton global bonus-rollover config row. Default
 * multiplier is 1x (BF-326 locked decision) - Super-Admin editable afterward via
 * PATCH /backoffice/wallet/bonus-rollover-config.
 */
export async function seedBonusRolloverConfig(db: DrizzleDb): Promise<void> {
  await db
    .insert(walletBonusRolloverConfig)
    .values({ singletonKey: 'global', multiplier: '1' })
    .onConflictDoNothing({ target: walletBonusRolloverConfig.singletonKey });
}
