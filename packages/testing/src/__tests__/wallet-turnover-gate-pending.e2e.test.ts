import { describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { readJson, registerAndMaterializePlayer } from '../index.js';
import { expectMoney, useBonusLockHarness } from './support/bonus-lock-harness.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './support/turnover-gate-config.js';

const { app, admin, drizzle, commands, withdraw, bet } = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-block-config',
    file: './test-wallet-turnover-block-config-plugin.ts',
  },
  rates: false,
});

const unratedCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

const quote = (baseCurrency: string, rate: string) =>
  drizzle()
    .insert(exchangeRateQuote)
    .values({ baseCurrency, quoteCurrency: 'USD', rate, providerAsOf: new Date() });

async function owingUnpriced(amount: string) {
  const registered = await registerAndMaterializePlayer(app(), {
    email: `turnover-gate-unpriced-${randomUUID()}@e2e.test`,
  });
  const funded = await admin().post('/wallet/manual-adjustments', {
    userId: registered.userId,
    direction: 'credit',
    amount: '50',
    currency: 'USD',
    reason: 'turnover gate test funds',
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
      requiredInCurrency: amount,
      source: 'grant_conversion',
      sourceRef: randomUUID(),
    });
  });
  return { ...registered, currency };
}

async function expectRefused(res: Response, remaining: string, pending: boolean) {
  expect(res.status).toBe(409);
  const body = await readJson(res);
  expect(body).toMatchObject({
    message: TEST_TURNOVER_LOCKED_MESSAGE,
    data: { reason: 'turnover_requirement_unmet', outflow: 'withdrawal', pending },
  });
  expectMoney(body.data.remaining, remaining, 'remaining');
}

describe('a withdrawal over an unpriced requirement', () => {
  it('refuses as pending with nothing left, and decides on the new requirement once priced', async () => {
    const { client, userId, currency } = await owingUnpriced('10');
    await bet(userId, '25', randomUUID());

    await expectRefused(await withdraw(client, '1'), '0', true);

    await quote(currency, '2');
    expect((await withdraw(client, '1')).status).toBe(200);
    const summary = await readJson(await client.get('/wallet/turnover'));
    expect(summary.pendingCount).toBe(0);
    expectMoney(summary.required, '20', 'required');
  });

  it('refuses on the priced remainder and keeps the price after the refusal', async () => {
    const { client, currency } = await owingUnpriced('10');
    await quote(currency, '2');

    await expectRefused(await withdraw(client, '1'), '20', false);

    const summary = await readJson(await client.get('/wallet/turnover'));
    expect(summary).toMatchObject({ pendingCount: 0, locked: true });
    expectMoney(summary.required, '20', 'required');
  });
});
