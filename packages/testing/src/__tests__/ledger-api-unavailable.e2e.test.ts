import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  LEDGER_API_V1,
  LedgerV1MoveOutcomeSchema,
  PLAY_ELIGIBILITY_PROJECTION,
  RG_LIMIT_LEDGER,
} from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import {
  ledgerApiRequest,
  ledgerPlayEligibility,
  ledgerProjectionHeartbeat,
} from '@openora/core/wallet/schema';
import { balanceOf, bootWalletE2e, closeWalletE2e, type WalletE2e } from './support/wallet.js';
import { allLedgerRowsOf, fundedBettor, newGame, scaled } from './support/casino.js';

const ENV = {
  INTERNAL_API_SECRETS: 'x'.repeat(32),
  MONEY_PORTS_CALLERS: 'platform',
  LEDGER_PROJECTION_HEARTBEAT_MS: '3600000',
};

let e2e: WalletE2e;
const saved = Object.keys(ENV).map((key) => [key, process.env[key]] as const);

beforeAll(async () => {
  Object.assign(process.env, ENV);
  e2e = await bootWalletE2e();
  const db = e2e.app.container.get(DRIZZLE).db;
  await vi.waitFor(async () => {
    expect(await db.select().from(ledgerProjectionHeartbeat)).toHaveLength(2);
  });
}, 120_000);

afterAll(async () => {
  await closeWalletE2e(e2e);
  for (const [key, value] of saved) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('the Ledger API while a projection owner has stopped beating', () => {
  it('refuses a bet as unavailable without storing the key, and decides the same key normally once the owner beats', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const ledger = e2e.app.container.get(LEDGER_API_V1);
    const db = e2e.app.container.get(DRIZZLE).db;
    const key = {
      userId: bettor.userId,
      gameId,
      currency: bettor.currency,
      providerName: `vendor-${randomUUID().slice(0, 8)}`,
      providerRefId: `bet-${randomUUID()}`,
      externalRoundId: `round-${randomUUID()}`,
      amount: '7',
      wager: { product: 'casino' as const },
    };
    const requestRows = () =>
      db
        .select({ response: ledgerApiRequest.response })
        .from(ledgerApiRequest)
        .where(eq(ledgerApiRequest.providerRefId, key.providerRefId));
    const betRows = async () =>
      (await allLedgerRowsOf(e2e, bettor.userId)).filter(
        (row) => row.providerRefId === key.providerRefId,
      );
    await db.delete(ledgerProjectionHeartbeat);

    const stale = LedgerV1MoveOutcomeSchema.parse(await ledger.bet(key));

    expect(stale).toEqual({ status: 'refused', reason: 'ledger_unavailable' });
    expect(await requestRows()).toEqual([]);
    expect(await betRows()).toEqual([]);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));

    await e2e.app.container.get(PLAY_ELIGIBILITY_PROJECTION).heartbeat();
    await e2e.app.container.get(RG_LIMIT_LEDGER).heartbeat();
    const retried = LedgerV1MoveOutcomeSchema.parse(await ledger.bet(key));
    const replayed = LedgerV1MoveOutcomeSchema.parse(await ledger.bet(key));

    expect(retried.status).toBe('applied');
    expect(replayed.status).toBe('replayed');
    expect(await betRows()).toEqual([
      expect.objectContaining({ type: 'bet', direction: 'debit', amount: scaled('7') }),
    ]);
    expect(await requestRows()).toHaveLength(1);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('43'));
  });

  it('still refuses a blocked player as blocked and stores it, so a retry after the block lifts stays refused', async () => {
    const bettor = await fundedBettor(e2e);
    const { gameId } = await newGame(e2e);
    const ledger = e2e.app.container.get(LEDGER_API_V1);
    const db = e2e.app.container.get(DRIZZLE).db;
    const key = {
      userId: bettor.userId,
      gameId,
      currency: bettor.currency,
      providerName: `vendor-${randomUUID().slice(0, 8)}`,
      providerRefId: `bet-${randomUUID()}`,
      externalRoundId: `round-${randomUUID()}`,
      amount: '7',
      wager: { product: 'casino' as const },
    };
    const setBlocked = (rgBlocked: boolean) =>
      db
        .update(ledgerPlayEligibility)
        .set({ rgBlocked, rgBlockedUntil: null })
        .where(eq(ledgerPlayEligibility.userId, bettor.userId));
    await setBlocked(true);
    await db.delete(ledgerProjectionHeartbeat);

    const blocked = LedgerV1MoveOutcomeSchema.parse(await ledger.bet(key));

    expect(blocked).toEqual({ status: 'refused', reason: 'player_blocked' });

    await setBlocked(false);
    await e2e.app.container.get(PLAY_ELIGIBILITY_PROJECTION).heartbeat();
    await e2e.app.container.get(RG_LIMIT_LEDGER).heartbeat();
    const retried = LedgerV1MoveOutcomeSchema.parse(await ledger.bet(key));

    expect(retried).toEqual({ status: 'refused', reason: 'player_blocked' });
    expect(
      await db
        .select({ response: ledgerApiRequest.response })
        .from(ledgerApiRequest)
        .where(eq(ledgerApiRequest.providerRefId, key.providerRefId)),
    ).toHaveLength(1);
    expect(await balanceOf(e2e, bettor.userId, bettor.currency)).toBe(scaled('50'));
  });
});
