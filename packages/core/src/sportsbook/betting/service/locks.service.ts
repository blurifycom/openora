import { sql } from 'drizzle-orm';
import type { DrizzleTx } from '@openora/core/server';
import type { Uuid } from '@openora/core/contracts';
import type { SportsbookBetRow } from '../schema/index.js';

// Lock order, every path: config -> player -> bet -> eligibility row (FOR SHARE: the identity user
// row through PLAY_ELIGIBILITY on a session issue, the `ledger_play_eligibility` row through
// LEDGER_PLAY_ELIGIBILITY on a stake) -> wallet and debt rows -> audit_log. Identity's publisher
// takes the user row, then the ledger row exclusively, and never a sportsbook lock, so it cannot
// close a cycle with a stake (ADR-0054). Wallet and debt rows are only touched
// under the player lock, which is what makes their relative order free; the wallet's own advisory
// locks (the bare user id, `promo-round-settle:`) come after ours. Findings are written before any
// audit row. Each helper takes one transaction-scoped advisory lock, released at commit or rollback.
// The two-int form keeps these keys out of the single-key space every other module hashes into.

const CONFIG_SPACE = 'sportsbook:config';
const PLAYER_SPACE = 'sportsbook:player';
const BET_SPACE = 'sportsbook:bet';

/** Reserve and session issue take it shared; config writes, suspend and resume take it exclusive. */
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

/** Only a cancel for a bet core never saw takes it: that path has no player to lock. */
export async function lockBet(
  tx: DrizzleTx,
  provider: SportsbookBetRow['provider'],
  providerBetId: SportsbookBetRow['providerBetId'],
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${BET_SPACE}), hashtext(${`${provider}:${providerBetId}`}))`,
  );
}
