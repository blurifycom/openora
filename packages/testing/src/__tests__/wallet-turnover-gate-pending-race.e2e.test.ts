import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { walletTurnoverEntry } from '@openora/core/wallet/schema';
import { readJson, registerAndMaterializePlayer } from '../index.js';
import { expectMoney, useBonusLockHarness } from './support/bonus-lock-harness.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './support/turnover-gate-config.js';

const { app, admin, drizzle, commands, withdraw } = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-block-config',
    file: './test-wallet-turnover-block-config-plugin.ts',
  },
  rates: false,
});

const unratedCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

describe('concurrent withdrawals over one unpriced requirement', () => {
  it('price it once, refuse every one on the priced remainder and keep the price', async () => {
    const registered = await registerAndMaterializePlayer(app(), {
      email: `turnover-pending-race-${randomUUID()}@e2e.test`,
    });
    const funded = await admin().post('/wallet/manual-adjustments', {
      userId: registered.userId,
      direction: 'credit',
      amount: '50',
      currency: 'USD',
      reason: 'turnover pending race funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const currency = unratedCurrency();
    await drizzle().transaction(async (tx) => {
      const wallet = commands();
      if (!wallet.addTurnoverRequirement) {
        throw new Error('the core wallet binds addTurnoverRequirement');
      }
      await wallet.addTurnoverRequirement(tx, {
        userId: registered.userId,
        currency,
        requiredInCurrency: '10',
        source: 'grant_conversion',
        sourceRef: randomUUID(),
      });
    });

    const refused = await withdraw(registered.client, '1');
    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({ data: { pending: true } });

    await drizzle().insert(exchangeRateQuote).values({
      baseCurrency: currency,
      quoteCurrency: 'USD',
      rate: '2',
      providerAsOf: new Date(),
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => withdraw(registered.client, '1')),
    );

    for (const res of results) {
      expect(res.status).toBe(409);
      const body = await readJson(res);
      expect(body).toMatchObject({
        message: TEST_TURNOVER_LOCKED_MESSAGE,
        data: { reason: 'turnover_requirement_unmet', pending: false },
      });
      expectMoney(body.data.remaining, '20', 'remaining');
    }
    const summary = await readJson(await registered.client.get('/wallet/turnover'));
    expect(summary).toMatchObject({ pendingCount: 0, locked: true });
    expectMoney(summary.required, '20', 'required');
    const entries = await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, registered.userId));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: 'counted' });
    expectMoney(String(entries[0]?.required), '20', 'entry required');
  });
});
