import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { eventOutbox, moneyCompare } from '@openora/core/server';
import type { WagerProduct } from '@openora/core/contracts';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { wallet, walletTransaction, walletTurnoverEntry } from '@openora/core/wallet/schema';
import { readJson, type TestClient } from '../index.js';
import { expectMoney, useBonusLockHarness } from './support/bonus-lock-harness.js';
import { TEST_LOCKED_FUNDS_MESSAGE } from './support/test-bonus-withdrawal-block-config-plugin.js';
import { TEST_TURNOVER_LOCKED_MESSAGE } from './support/turnover-gate-config.js';

const {
  admin,
  drizzle,
  commands,
  deposit,
  player,
  grant,
  realBalance,
  ledgerRows,
  withdraw,
  btcHolder,
  swap,
} = useBonusLockHarness('block', {
  config: {
    id: 'testing-wallet-turnover-block-config',
    file: './test-wallet-turnover-block-config-plugin.ts',
  },
});

type Expected = {
  required: string;
  progress: string;
  remaining: string;
  pending?: boolean;
  outflow?: 'withdrawal' | 'transfer';
};

async function expectTurnoverLocked(
  res: Response,
  { required, progress, remaining, pending = false, outflow = 'withdrawal' }: Expected,
): Promise<void> {
  expect(res.status).toBe(409);
  const body = await readJson(res);
  expect(body).toMatchObject({
    message: TEST_TURNOVER_LOCKED_MESSAGE,
    data: { reason: 'turnover_requirement_unmet', outflow, pivotCurrency: 'USD', pending },
  });
  expectMoney(body.data.required, required, 'required');
  expectMoney(body.data.progress, progress, 'progress');
  expectMoney(body.data.remaining, remaining, 'remaining');
}

const stake = (userId: string, amount: string, product: WagerProduct = 'casino') =>
  drizzle().transaction(async (tx) => {
    const round = randomUUID();
    const outcome = await commands().debit(tx, {
      userId,
      amount,
      type: 'bet',
      currency: 'USD',
      context: { provider: 'aggregator', product },
      providerRef: {
        providerName: 'aggregator',
        providerRefId: randomUUID(),
        externalRoundId: round,
      },
    });
    expect(outcome).toMatchObject({ ok: true, moved: true });
    return outcome;
  });

const credit = (userId: string, amount: string, currency = 'USD') =>
  admin().post('/wallet/manual-adjustments', {
    userId,
    direction: 'credit',
    amount,
    currency,
    reason: 'turnover gate test funds',
    idempotencyKey: randomUUID(),
  });

async function summaryOf(client: TestClient) {
  const res = await client.get('/wallet/turnover');
  expect(res.status).toBe(200);
  return readJson(res);
}

const clear = (userId: string) =>
  admin().post(`/wallet/admin/players/${userId}/turnover/clear`, {
    userId,
    reason: 'verified source of funds',
  });

const metEvents = (userId: string) =>
  drizzle()
    .select()
    .from(eventOutbox)
    .where(
      and(
        eq(eventOutbox.topic, 'wallet.turnover.met'),
        sql`${eventOutbox.payload}->>'userId' = ${userId}`,
      ),
    );

const quote = (baseCurrency: string, rate: string) =>
  drizzle()
    .insert(exchangeRateQuote)
    .values({ baseCurrency, quoteCurrency: 'USD', rate, providerAsOf: new Date() });

async function balanceRead(client: TestClient) {
  const res = await client.get('/wallet/balance');
  expect(res.status).toBe(200);
  return readJson(res);
}

describe('a withdrawal while turnover is unmet', () => {
  it('refuses any amount, moves nothing, and pays once the deposit is wagered', async () => {
    const { client, userId } = await player('100');

    await expectTurnoverLocked(await withdraw(client, '1'), {
      required: '100',
      progress: '0',
      remaining: '100',
    });

    expectMoney(await realBalance(userId), '100', 'balance');
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
    await stake(userId, '60');
    await stake(userId, '40', 'live-casino');
    expect((await withdraw(client, '1')).status).toBe(200);
    expectMoney(await realBalance(userId), '0', 'balance after');
    expect(await metEvents(userId)).toHaveLength(1);
  });

  it('refuses a withdrawal in a currency other than the one deposited', async () => {
    const { client, userId } = await player('100');
    expect((await credit(userId, '20', 'EUR')).status).toBe(200);

    const res = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'EUR',
    });

    await expectTurnoverLocked(res, { required: '100', progress: '0', remaining: '100' });
    expectMoney(await realBalance(userId, 'EUR'), '20', 'EUR balance');
  });

  it('accepts a withdrawal once less than the dust threshold remains', async () => {
    const { client, userId } = await player('100');
    expect((await credit(userId, '100')).status).toBe(200);
    await stake(userId, '99.995');

    expectMoney((await summaryOf(client)).remaining, '0.005', 'remaining');
    expect((await withdraw(client, '50')).status).toBe(200);
  });

  it('accepts a withdrawal after staff clear the requirement', async () => {
    const { client, userId } = await player('100');
    await expectTurnoverLocked(await withdraw(client, '10'), {
      required: '100',
      progress: '0',
      remaining: '100',
    });

    const cleared = await clear(userId);

    expect(cleared.status).toBe(200);
    expect(await readJson(cleared)).toMatchObject({ cleared: true });
    expect((await withdraw(client, '10')).status).toBe(200);
  });

  it('never accepts a withdrawal racing the stake that meets the requirement before that stake', async () => {
    for (let run = 0; run < 5; run += 1) {
      const { client, userId } = await player('100');
      expect((await credit(userId, '100')).status).toBe(200);
      await stake(userId, '60');

      const [first, second, completing] = await Promise.allSettled([
        withdraw(client, '10'),
        withdraw(client, '10'),
        stake(userId, '40'),
      ]);

      expect(completing.status).toBe('fulfilled');
      for (const outcome of [first, second]) {
        expect(outcome.status).toBe('fulfilled');
        if (outcome.status === 'fulfilled') {
          expect([200, 409]).toContain(outcome.value.status);
        }
      }
      const accepted = await drizzle()
        .select({ balanceAfter: walletTransaction.balanceAfter })
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, 'withdrawal')));
      for (const { balanceAfter } of accepted) {
        expect(moneyCompare(String(balanceAfter), '100')).toBeLessThan(0);
      }
    }
  });
});

describe('a swap while turnover is unmet', () => {
  it('settles and adds a requirement for the coins it bought', async () => {
    await quote('USDT', '1').onConflictDoNothing();
    await quote('BTC', '50000').onConflictDoNothing();
    const { client, userId } = await player('100');
    expect((await credit(userId, '0.02', 'BTC')).status).toBe(200);

    const res = await swap(client, '0.01');

    expect(res.status).toBe(200);
    const entries = await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(
        and(eq(walletTurnoverEntry.userId, userId), eq(walletTurnoverEntry.source, 'swap_in')),
      );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ currency: 'USDT', status: 'counted' });
  });

  it('still refuses a swap over bonus-locked money', async () => {
    const { client, userId } = await btcHolder();
    await deposit(client, '100');

    const res = await swap(client, '0.01');

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      message: TEST_LOCKED_FUNDS_MESSAGE,
      data: { reason: 'bonus_funds_locked', outflow: 'swap', currency: 'BTC' },
    });
    expectMoney(await realBalance(userId, 'BTC'), '0.02', 'BTC balance');
  });
});

describe('a locking bonus and unmet turnover together', () => {
  it('reads the stricter lock, never the sum, and refuses on the bonus first', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    const read = await balanceRead(client);
    expectMoney(read.locked, '150', 'locked');
    expectMoney(read.free, '0', 'free');
    expectMoney(read.bonusLocked, '100', 'bonusLocked');
    const listed = await readJson(await client.get('/wallet/balances'));
    expect(listed.balances).toEqual([expect.objectContaining(read)]);
    const staff = await readJson(await admin().get(`/backoffice/promo/players/${userId}/funds`));
    expect(staff.balances).toEqual([expect.objectContaining(read)]);
    expect(staff.turnover).toMatchObject({ enabled: true, locked: true });

    const overBonus = await withdraw(client, '60');
    expect(overBonus.status).toBe(409);
    expect(await readJson(overBonus)).toMatchObject({
      message: TEST_LOCKED_FUNDS_MESSAGE,
      data: { reason: 'bonus_funds_locked', outflow: 'withdrawal' },
    });
    await expectTurnoverLocked(await withdraw(client, '10'), {
      required: '150',
      progress: '0',
      remaining: '150',
    });

    expect((await clear(userId)).status).toBe(200);
    const after = await balanceRead(client);
    expectMoney(after.locked, '100', 'locked after');
    expectMoney(after.bonusLocked, '100', 'bonusLocked after');
    expectMoney(after.free, '50', 'free after');
    expect(await readJson(await withdraw(client, '60'))).toMatchObject({
      data: { reason: 'bonus_funds_locked' },
    });
    expect((await withdraw(client, '50')).status).toBe(200);
  });
});

describe('a transfer out through the wallet command port while turnover is unmet', () => {
  const debitOf = (
    userId: string,
    type: 'gift' | 'rain' | 'donation' | 'withdrawal' | 'swap_out' | 'bet' | 'manual_debit',
    amount = '10',
  ) =>
    drizzle().transaction((tx) =>
      commands().debit(tx, {
        userId,
        amount,
        type,
        currency: 'USD',
        providerRef: { providerName: 'gifts', providerRefId: randomUUID() },
      }),
    );

  it('refuses a gift and rolls back both legs', async () => {
    const sender = await player('150');
    const recipient = await player('10');
    const gift = (userId: string) => ({
      userId,
      amount: '10',
      type: 'gift' as const,
      currency: 'USD',
      providerRef: { providerName: 'gifts', providerRefId: randomUUID() },
    });

    await expect(
      drizzle().transaction(async (tx) => {
        await commands().credit(tx, gift(recipient.userId));
        await commands().debit(tx, gift(sender.userId));
      }),
    ).rejects.toMatchObject({
      name: 'TurnoverLockedError',
      message: TEST_TURNOVER_LOCKED_MESSAGE,
      data: { reason: 'turnover_requirement_unmet', outflow: 'transfer', pending: false },
    });
    expectMoney(await realBalance(sender.userId), '150', 'sender balance');
    const recipientGrants = await drizzle()
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.userId, recipient.userId));
    expect(recipientGrants).toEqual([]);
  });

  it.each([
    ['gift', 'transfer'],
    ['rain', 'transfer'],
    ['donation', 'transfer'],
    ['withdrawal', 'withdrawal'],
  ] as const)('refuses a %s debit as a %s', async (type, outflow) => {
    const { userId } = await player('150');

    await expect(debitOf(userId, type)).rejects.toMatchObject({
      name: 'TurnoverLockedError',
      data: { outflow },
    });
    expectMoney(await realBalance(userId), '150', 'balance');
  });

  it('lets a swap out-leg, a bet and an admin debit through', async () => {
    const { userId } = await player('150');

    expect(await debitOf(userId, 'swap_out')).toMatchObject({ ok: true });
    expect(await debitOf(userId, 'bet')).toMatchObject({ ok: true });
    expect(await debitOf(userId, 'manual_debit')).toMatchObject({ ok: true });
    expectMoney(await realBalance(userId), '120', 'balance');
  });

  it('reports nothing movable', async () => {
    const { userId } = await player('150');

    const funds = await drizzle().transaction((tx) => {
      const port = commands();
      if (!port.movableFunds) {
        throw new Error('the core wallet binds movableFunds');
      }
      return port.movableFunds(tx, { userId, currency: 'USD' });
    });

    expectMoney(funds.real, '150', 'real');
    expectMoney(funds.locked, '150', 'locked');
    expectMoney(funds.free, '0', 'free');
  });
});
