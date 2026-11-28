import type { DrizzleDb } from '@openora/core/server';
import { walletAutoWithdrawalConfig } from '../schema/index.js';

export async function seedAutoWithdrawalConfig(db: DrizzleDb): Promise<void> {
  await db
    .insert(walletAutoWithdrawalConfig)
    .values({ singletonKey: 'global', fiatThreshold: '0', cryptoThreshold: '0' })
    .onConflictDoNothing({ target: walletAutoWithdrawalConfig.singletonKey });
}
