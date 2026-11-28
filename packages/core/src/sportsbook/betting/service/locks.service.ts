import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';
import type { SportsbookBetRow } from '../schema/index.js';

const CONFIG_SPACE = 'sportsbook:config';
const PLAYER_SPACE = 'sportsbook:player';
const BET_SPACE = 'sportsbook:bet';

export async function lockConfig(tx: DrizzleTx, mode: 'shared' | 'exclusive'): Promise<void> {
  await (mode === 'shared'
    ? tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${CONFIG_SPACE}), 0)`)
    : tx.execute(sql`select pg_advisory_xact_lock(hashtext(${CONFIG_SPACE}), 0)`));
}

export async function lockPlayer(tx: DrizzleTx, userId: Uuid): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${PLAYER_SPACE}), hashtext(${userId}))`,
  );
}

export async function lockBet(
  tx: DrizzleTx,
  provider: SportsbookBetRow['provider'],
  providerBetId: SportsbookBetRow['providerBetId'],
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${BET_SPACE}), hashtext(${`${provider}:${providerBetId}`}))`,
  );
}
