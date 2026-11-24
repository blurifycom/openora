import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import {
  wallet,
  walletTransaction,
  walletTurnover,
  walletTurnoverEntry,
} from '@openora/core/wallet/schema';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const { drizzle, player, grant, bet, withdraw, deposit } = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-off-config',
    file: './test-wallet-turnover-off-config-plugin.ts',
  },
});

describe('a player while the turnover multiplier is 0', () => {
  it('keeps balance reads free of turnover keys, stamps no ledger row and withdraws freely', async () => {
    const { client, userId } = await player('100');
    expect(await bet(userId, '30', randomUUID())).toMatchObject({ ok: true });
    await deposit(client, '10');

    const read = await readJson(await client.get('/wallet/balance'));
    expect(Object.keys(read)).not.toContain('bonusLocked');
    const list = await readJson(await client.get('/wallet/balances'));
    for (const balance of list.balances) {
      expect(Object.keys(balance)).not.toContain('bonusLocked');
    }

    const rows = await drizzle()
      .select({
        state: walletTransaction.turnoverState,
        contribution: walletTransaction.turnoverContribution,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(eq(wallet.userId, userId));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row).toEqual({ state: null, contribution: null });
    }

    expect((await withdraw(client, '50')).status).toBe(200);
    expect(
      await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
    ).toEqual([]);
    expect(
      await drizzle()
        .select()
        .from(walletTurnoverEntry)
        .where(inArray(walletTurnoverEntry.userId, [userId])),
    ).toEqual([]);
  });

  it('reports a bonus lock as locked and free, never bonusLocked, exactly as before', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    const read = await readJson(await client.get('/wallet/balance'));

    expectMoney(read.locked, '100', 'locked');
    expectMoney(read.free, '50', 'free');
    expect(Object.keys(read)).not.toContain('bonusLocked');
  });
});
