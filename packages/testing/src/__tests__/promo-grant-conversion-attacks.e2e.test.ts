import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { wallet, walletTransaction, walletTurnoverEntry } from '@openora/core/wallet/schema';
import { readJson } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';

const CONVERT = '/backoffice/promo/grants/convert-transfer-grants';

const { admin, drizzle, player, grant, grantRow, realBalance, withdraw } = useBonusLockHarness(
  'block',
  {
    config: {
      id: 'testing-promo-grant-conversion-config',
      file: './test-promo-grant-conversion-config-plugin.ts',
    },
  },
);

const conversionCredits = (userId: string) =>
  drizzle()
    .select({ id: walletTransaction.id })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(
      and(eq(wallet.userId, userId), eq(walletTransaction.providerName, 'promo:grant-conversion')),
    );

const entriesOf = (userId: string) =>
  drizzle().select().from(walletTurnoverEntry).where(eq(walletTurnoverEntry.userId, userId));

describe('conversion input validation', () => {
  it.each([
    ['limit 0', { sources: ['gift'], limit: 0 }],
    ['limit 501', { sources: ['gift'], limit: 501 }],
    ['limit 1.5', { sources: ['gift'], limit: 1.5 }],
    ['no sources', { sources: [] }],
    ['a deposit source', { sources: ['deposit'] }],
    ['a string dry run', { sources: ['gift'], dryRun: 'yes' }],
  ])('refuses %s without converting anything', async (_label, body) => {
    const { userId } = await player('1');
    const grantId = await grant(userId, { source: 'gift', amount: '10', linked: '0' });

    const res = await admin().post(CONVERT, body);

    expect(res.status).toBe(400);
    expect((await grantRow(grantId)).status).toBe('active');
  });
});

describe('two conversions at once', () => {
  it('credit the grant once and write one requirement', async () => {
    for (let run = 0; run < 3; run += 1) {
      const { userId } = await player('5');
      const grantId = await grant(userId, {
        source: 'gift',
        amount: '10',
        linked: '0',
        multiplier: '3',
      });

      const [a, b] = await Promise.all([
        admin().post(CONVERT, { sources: ['gift'] }),
        admin().post(CONVERT, { sources: ['gift'] }),
      ]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect((await grantRow(grantId)).status).toBe('completed');
      expect(await conversionCredits(userId)).toHaveLength(1);
      expect((await entriesOf(userId)).filter((e) => e.source === 'grant_conversion')).toHaveLength(
        1,
      );
      expectMoney(await realBalance(userId), '15', 'real balance');
    }
  });
});

describe('a grant with nothing left to wager', () => {
  it('converts to cash that is free to withdraw and writes no entry', async () => {
    const { client, userId } = await player('5');
    const grantId = await grant(userId, {
      source: 'gift',
      amount: '10',
      linked: '0',
      multiplier: '3',
    });
    const row = await grantRow(grantId);
    await drizzle()
      .update(promoGrant)
      .set({ wageringProgress: row.wageringRequired })
      .where(eq(promoGrant.id, grantId));

    const res = await admin().post(CONVERT, { sources: ['gift'] });

    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.converted).toHaveLength(1);
    expect(body.converted[0].entryStatus).toBeNull();
    expect(await entriesOf(userId)).toEqual([]);
    expect((await withdraw(client, '15')).status).toBe(200);
  });
});
