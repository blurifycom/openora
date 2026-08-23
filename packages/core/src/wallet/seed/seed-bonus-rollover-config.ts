import type { DrizzleDb } from '@openora/core/server';
import { walletBonusRolloverConfig } from '../schema/index.js';

export async function seedBonusRolloverConfig(db: DrizzleDb): Promise<void> {
  await db
    .insert(walletBonusRolloverConfig)
    .values({ singletonKey: 'global', multiplier: '1' })
    .onConflictDoNothing({ target: walletBonusRolloverConfig.singletonKey });
}
