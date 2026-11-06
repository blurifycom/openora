import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { WALLET_COMMANDS, JOB_QUEUE, queue } from '@openora/core/contracts';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { promoRankPeriodWager, promoRankTier } from '@openora/core/promo/schema/gamification';
import { registerAndMaterializePlayer, bootE2e, closeE2e, readJson, type E2e } from '../index.js';

let e2e: E2e;
beforeAll(async () => {
  e2e = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'test-rank-margin-config',
        path: fileURLToPath(
          new URL('./fixtures/test-rank-margin-config-plugin.ts', import.meta.url),
        ),
      },
    ],
  });
}, 60_000);
afterAll(async () => {
  await closeE2e(e2e);
});

describe('configured rank margin through wallet settlement', () => {
  it('exposes the configured basis and reverses cash bets through the real bonus engine', async () => {
    const { app } = e2e;
    const db = app.container.get(DRIZZLE).db;
    const wallet = app.container.get(WALLET_COMMANDS);
    const { userId, client } = await registerAndMaterializePlayer(app, {
      email: `rank-margin-${randomUUID()}@example.test`,
    });
    expect((await readJson(await client.get('/promo/ranks'))).periodicBasis).toBe('margin');
    expect((await readJson(await app.app.request('/promo/ranks/ladder'))).periodicBasis).toBe(
      'margin',
    );
    const round = randomUUID();
    await db.transaction((tx) =>
      wallet.credit(tx, {
        userId,
        currency: 'USDT',
        amount: '300',
        type: 'deposit',
        allowNewWallet: true,
        allowNewCurrency: true,
        providerRef: { providerName: 'aggregator', providerRefId: randomUUID() },
      }),
    );
    for (const rtp of ['0.90', '0.99']) {
      expect(
        await db.transaction((tx) =>
          wallet.debit(tx, {
            userId,
            currency: 'USDT',
            amount: '100',
            type: 'bet',
            context: { provider: 'aggregator', product: 'casino', rtp },
            providerRef: {
              providerName: 'aggregator',
              providerRefId: randomUUID(),
              externalRoundId: round,
            },
          }),
        ),
      ).toMatchObject({ ok: true });
    }
    const margins = async () =>
      (
        await db
          .select({ margin: promoRankPeriodWager.margin })
          .from(promoRankPeriodWager)
          .where(eq(promoRankPeriodWager.userId, userId))
      ).map((row) => row.margin);
    expect(await margins()).toEqual(Array(3).fill('11.000000000000000000'));
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        await db.transaction((tx) =>
          wallet.credit(tx, {
            userId,
            currency: 'USDT',
            amount: '200',
            type: 'bet_reversal',
            allowNewCurrency: true,
            providerRef: {
              providerName: 'aggregator',
              providerRefId: randomUUID(),
              externalRoundId: round,
            },
          }),
        ),
      ).toMatchObject({ ok: true });
      expect(await margins()).toEqual(Array(3).fill('0.000000000000000000'));
    }
  });
  it('uses the configured margin basis when the real periodic payout job runs', async () => {
    const { app } = e2e;
    const db = app.container.get(DRIZZLE).db;
    const wallet = app.container.get(WALLET_COMMANDS);
    const { userId } = await registerAndMaterializePlayer(app, {
      email: `rank-periodic-${randomUUID()}@example.test`,
    });
    await db
      .update(promoRankTier)
      .set({ dailyBonusPercent: '10', dailyBonus: '100' })
      .where(eq(promoRankTier.key, 'bronze'));
    expect(
      await db.transaction((tx) =>
        wallet.credit(tx, {
          userId,
          currency: 'USDT',
          amount: '100',
          type: 'deposit',
          allowNewWallet: true,
          allowNewCurrency: true,
          providerRef: { providerName: 'aggregator', providerRefId: randomUUID() },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await db.transaction((tx) =>
        wallet.debit(tx, {
          userId,
          currency: 'USDT',
          amount: '100',
          type: 'bet',
          context: { provider: 'aggregator', product: 'casino', rtp: '0.90' },
          providerRef: {
            providerName: 'aggregator',
            providerRefId: randomUUID(),
            externalRoundId: randomUUID(),
          },
        }),
      ),
    ).toMatchObject({ ok: true });
    const [counter] = await db
      .select()
      .from(promoRankPeriodWager)
      .where(and(eq(promoRankPeriodWager.userId, userId), eq(promoRankPeriodWager.kind, 'daily')));
    if (!counter) {
      throw new Error('missing daily counter');
    }
    const start = new Date(`${counter.periodKey.slice('rank-daily:'.length)}:00:00Z`);
    start.setUTCDate(start.getUTCDate() - 1);
    const sourceRef = `rank-daily:${start.toISOString().slice(0, 13)}`;
    await db
      .update(promoRankPeriodWager)
      .set({ periodKey: sourceRef })
      .where(eq(promoRankPeriodWager.id, counter.id));
    await app.container.get(JOB_QUEUE).enqueue(queue('promo-rank-payout'), { kind: 'daily' });
    await vi.waitFor(
      async () => {
        const [grant] = await db
          .select({ amount: promoGrant.grantedAmount })
          .from(promoGrant)
          .where(and(eq(promoGrant.userId, userId), eq(promoGrant.sourceRef, sourceRef)));
        expect(grant?.amount).toBe('1.000000000000000000');
      },
      { timeout: 10_000 },
    );
  });
});
