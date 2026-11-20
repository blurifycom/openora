import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { moneyAdd, moneyCompare } from '@openora/core/server';
import type { WalletTransactionType } from '@openora/core/contracts';
import { promoGrant } from '@openora/core/promo/schema/bonus';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment, adminRolePermission } from '@openora/core/iam/schema';
import { readJson, type TestClient } from '../index.js';
import { expectMoney, useBonusLockHarness } from './fixtures/bonus-lock-harness.js';
import { TEST_LOCKED_FUNDS_MESSAGE } from './fixtures/test-bonus-withdrawal-block-config-plugin.js';

const {
  admin,
  drizzle,
  commands,
  deposit,
  player,
  grant,
  grantRow,
  realBalance,
  ledgerRows,
  withdraw,
  bet,
  lose,
  btcHolder,
  swap,
  anonymousGet,
} = useBonusLockHarness('block');

async function expectLocked(
  res: Response,
  { locked, free, outflow = 'withdrawal' }: { locked: string; free: string; outflow?: string },
): Promise<void> {
  expect(res.status).toBe(409);
  const body = await readJson(res);
  expect(body).toMatchObject({
    message: TEST_LOCKED_FUNDS_MESSAGE,
    data: { reason: 'bonus_funds_locked', outflow },
  });
  expectMoney(body.data.locked, locked, 'locked');
  expectMoney(body.data.free, free, 'free');
}

async function depositMatchOffer(terms: Record<string, unknown> = {}) {
  const res = await admin().post('/backoffice/promo/offers', {
    key: `lock-${randomUUID()}`,
    name: 'Deposit Match',
    status: 'active',
    currency: 'USD',
    matchPercent: '100',
    maxGrantAmount: '1000',
    minDeposit: '20',
    terms: { wageringMultiplier: '5', expiryDays: 30, ...terms },
    rules: { firstDepositOnly: false, excludedCountries: [] },
    requiresOptIn: true,
  });
  expect(res.status).toBe(200);
  return (await readJson(res)).id as string;
}

/** 50 of the player's own money, then a 100 deposit the offer matches. */
async function matchedDepositor(terms: Record<string, unknown> = {}) {
  const offerId = await depositMatchOffer(terms);
  const depositor = await player('50');
  expect((await depositor.client.post(`/promo/offers/${offerId}/opt-in`, {})).status).toBe(200);
  await deposit(depositor.client, '100');
  const [granted] = await drizzle()
    .select()
    .from(promoGrant)
    .where(eq(promoGrant.userId, depositor.userId));
  if (!granted) {
    throw new Error('the deposit was not matched');
  }
  return { ...depositor, grantId: granted.id };
}

async function balanceRead(client: TestClient): Promise<{ locked: string; free: string }> {
  const res = await client.get('/wallet/balance');
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.currency).toBe('USD');
  return { locked: body.locked, free: body.free };
}

const movableFunds = (userId: string, currency = 'USD') =>
  drizzle().transaction((tx) => {
    const wallet = commands();
    if (!wallet.movableFunds) {
      throw new Error('the core wallet binds movableFunds');
    }
    return wallet.movableFunds(tx, { userId, currency });
  });

describe('a withdrawal while a deposit bonus runs, in block mode', () => {
  it('refuses more than the free money with the operator message and moves nothing', async () => {
    const { client, userId, grantId } = await matchedDepositor();
    const before = await grantRow(grantId);

    await expectLocked(await withdraw(client, '60'), { locked: '100', free: '50' });

    expectMoney(await realBalance(userId), '150', 'balance');
    expect(await ledgerRows(userId, 'withdrawal')).toHaveLength(0);
    expect(await grantRow(grantId)).toEqual(before);
  });

  it('pays out the free money and leaves the bonus alone', async () => {
    const { client, userId, grantId } = await matchedDepositor();
    const before = await grantRow(grantId);

    const res = await withdraw(client, '50');

    expect(res.status).toBe(200);
    expectMoney(await realBalance(userId), '100', 'balance');
    expect(await grantRow(grantId)).toEqual(before);
  });

  it('answers a replayed withdrawal with its original result after a bonus starts locking', async () => {
    const { client, userId } = await player('50');
    const key = randomUUID();
    const first = await withdraw(client, '50', key);
    expect(first.status).toBe(200);
    const original = await readJson(first);
    await deposit(client, '100');
    await grant(userId);

    const replayed = await withdraw(client, '50', key);

    expect(replayed.status).toBe(200);
    expect((await readJson(replayed)).transactionId).toBe(original.transactionId);
  });

  it('lets two withdrawals that each fit but together do not through only once', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    const results = await Promise.all([withdraw(client, '40'), withdraw(client, '40')]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expectMoney(await realBalance(userId), '110', 'balance');
  });

  it('pays the free money out while a round staked from the bonus cash is open, and the rest once the bonus completes', async () => {
    const { client, userId } = await player('150');
    const grantId = await grant(userId, { order: 'last', multiplier: '0.3' });
    const round = randomUUID();
    expect(await bet(userId, '30', round)).toMatchObject({ ok: true });

    expect((await withdraw(client, '50')).status).toBe(200);

    await lose(userId, round);
    expect((await grantRow(grantId)).status).toBe('completed');
    const rest = await realBalance(userId);
    expect((await withdraw(client, rest)).status).toBe(200);
  });

  it('keeps bets and withdrawals racing on one balance free of deadlocks and inside the lock', async () => {
    const { client, userId } = await player('150');
    const grantId = await grant(userId, { linked: '60', unlinked: '40' });

    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 5 }, () => withdraw(client, '15')),
      ...Array.from({ length: 5 }, () => bet(userId, '10', randomUUID())),
    ]);

    for (const outcome of outcomes) {
      expect(outcome.status).toBe('fulfilled');
      if (outcome.status === 'fulfilled' && outcome.value instanceof Response) {
        expect([200, 409]).toContain(outcome.value.status);
      }
    }
    const row = await grantRow(grantId);
    expect(
      moneyCompare(await realBalance(userId), moneyAdd(row.unlinkedCash, row.linkedCash)),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe('the balance read', () => {
  it('shows the locked and free money the withdrawal refusal reports, and pays out exactly the free part', async () => {
    const { client, userId } = await matchedDepositor();

    const read = await balanceRead(client);
    expectMoney(read.locked, '100', 'locked');
    expectMoney(read.free, '50', 'free');
    const listed = await readJson(await client.get('/wallet/balances'));
    expect(listed.balances).toEqual([expect.objectContaining(read)]);

    await expectLocked(await withdraw(client, moneyAdd(read.free, '0.01')), read);
    expect((await withdraw(client, read.free)).status).toBe(200);
    expectMoney(await realBalance(userId), '100', 'balance');
    const after = await balanceRead(client);
    expectMoney(after.locked, '100', 'locked after');
    expectMoney(after.free, '0', 'free after');
  });

  it("reads nothing locked behind another player's bonus", async () => {
    const { client } = await player('150');
    const other = await player('150');
    await grant(other.userId);

    const read = await balanceRead(client);

    expectMoney(read.locked, '0', 'locked');
    expectMoney(read.free, '150', 'free');
  });

  it('refuses the balance read without a session', async () => {
    expect((await anonymousGet('/wallet/balance')).status).toBe(401);
  });
});

describe('the staff funds read', () => {
  const staffFunds = (userId: string) => admin().get(`/backoffice/promo/players/${userId}/funds`);

  it("shows staff the same balances, locked and free money as the player's own read", async () => {
    const { client, userId } = await matchedDepositor();
    await deposit(client, '5', 'EUR');

    const res = await staffFunds(userId);

    expect(res.status).toBe(200);
    const staff = await readJson(res);
    const own = await readJson(await client.get('/wallet/balances'));
    expect(staff).toEqual(own);
    expect(staff.balances.map((b: { currency: string }) => b.currency)).toEqual(['EUR', 'USD']);
    const usd = staff.balances.find((b: { currency: string }) => b.currency === 'USD');
    expectMoney(usd.locked, '100', 'locked');
    expectMoney(usd.free, '50', 'free');
  });

  async function staffWith(resource: 'bonus' | 'transaction') {
    const staff = await player('0.01');
    await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
    const [role] = await drizzle()
      .insert(adminRole)
      .values({ name: `${resource} reader ${randomUUID()}` })
      .returning({ id: adminRole.id });
    if (!role) {
      throw new Error('role insert returned no row');
    }
    await drizzle()
      .insert(adminRolePermission)
      .values({ roleId: role.id, resource, level: 'read' });
    await drizzle().insert(adminRoleAssignment).values({ userId: staff.userId, roleId: role.id });
    return staff.client;
  }

  it.each(['bonus', 'transaction'] as const)(
    'refuses staff who can read only %s',
    async (resource) => {
      const { userId } = await player('150');
      const staff = await staffWith(resource);

      expect((await staff.get(`/backoffice/promo/players/${userId}/funds`)).status).toBe(403);
    },
  );

  it('refuses a player reaching for it, even for their own funds', async () => {
    const { client, userId } = await player('150');

    expect((await client.get(`/backoffice/promo/players/${userId}/funds`)).status).toBe(403);
  });

  it('reads an unknown player as no balances, like the grant list', async () => {
    const res = await staffFunds(randomUUID());

    expect(res.status).toBe(200);
    expect((await readJson(res)).balances).toEqual([]);
  });
});

describe('which bonuses lock', () => {
  it('does not lock behind a rank bonus', async () => {
    const { client, userId } = await player('150');
    await grant(userId, { source: 'rank' });

    expect((await withdraw(client, '150')).status).toBe(200);
  });

  it('does not lock behind a deposit offer whose terms turn the lock off', async () => {
    const { client, grantId } = await matchedDepositor({ funds: { lockWithdrawals: false } });
    expect((await grantRow(grantId)).status).toBe('active');

    expect((await withdraw(client, '150')).status).toBe(200);
  });

  it('locks behind a manual bonus whose terms turn the lock on', async () => {
    const { client, userId } = await player('150');
    await grant(userId, { source: 'manual', lock: true });

    await expectLocked(await withdraw(client, '150'), { locked: '100', free: '50' });
  });

  it('does not lock one currency behind a bonus in another', async () => {
    const { client, userId } = await player('150');
    await grant(userId, { currency: 'EUR' });

    expect((await withdraw(client, '150')).status).toBe(200);
  });

  it("does not count another player's bonus", async () => {
    const { client } = await player('150');
    const other = await player('150');
    await grant(other.userId);

    expect((await withdraw(client, '150')).status).toBe(200);
  });

  it.each([
    ['expired', { status: 'expired' as const }],
    ['depleted', { status: 'depleted' as const }],
    ['past its expiry but not yet swept', { expiresAt: new Date(Date.now() - 60_000) }],
  ])('releases the lock on a bonus %s', async (_label, change) => {
    const { client, userId } = await player('150');
    const grantId = await grant(userId);
    await drizzle().update(promoGrant).set(change).where(eq(promoGrant.id, grantId));

    expect((await withdraw(client, '150')).status).toBe(200);
  });

  it('releases the lock on a bonus an admin forfeited', async () => {
    const { client, userId } = await player('150');
    const grantId = await grant(userId);
    const forfeited = await admin().post(`/backoffice/promo/grants/${grantId}/forfeit`, {
      note: 'player asked to cash out',
    });
    expect(forfeited.status).toBe(200);

    expect((await withdraw(client, '150')).status).toBe(200);
  });
});

describe('moving money out through the wallet command port', () => {
  const gift = (userId: string, amount: string) => ({
    userId,
    amount,
    type: 'gift' as const,
    currency: 'USD',
    providerRef: { providerName: 'gifts', providerRefId: randomUUID() },
  });

  it('reports what is movable under the same locks a debit takes', async () => {
    const { userId } = await player('150');
    await grant(userId);

    const funds = await movableFunds(userId, 'usd');

    expectMoney(funds.real, '150', 'real');
    expectMoney(funds.locked, '100', 'locked');
    expectMoney(funds.free, '50', 'free');
  });

  it('refuses a gift over the free money and rolls back both legs', async () => {
    const sender = await player('150');
    const recipient = await player('10');
    await grant(sender.userId);

    await expect(
      drizzle().transaction(async (tx) => {
        await commands().credit(tx, gift(recipient.userId, '60'));
        await commands().debit(tx, gift(sender.userId, '60'));
      }),
    ).rejects.toMatchObject({
      name: 'BonusFundsLockedError',
      data: { reason: 'bonus_funds_locked', outflow: 'transfer', currency: 'USD' },
    });
    expectMoney(await realBalance(sender.userId), '150', 'sender balance');
    const recipientGrants = await drizzle()
      .select()
      .from(promoGrant)
      .where(eq(promoGrant.userId, recipient.userId));
    expect(recipientGrants).toEqual([]);
  });

  it('lets a gift up to the free money through', async () => {
    const sender = await player('150');
    const recipient = await player('10');
    await grant(sender.userId);

    await drizzle().transaction(async (tx) => {
      await commands().credit(tx, gift(recipient.userId, '50'));
      expect(await commands().debit(tx, gift(sender.userId, '50'))).toMatchObject({ ok: true });
    });
    expectMoney(await realBalance(sender.userId), '100', 'sender balance');
  });

  it.each([
    ['withdrawal', 'withdrawal'],
    ['swap_out', 'swap'],
    ['bonus', 'transfer'],
    ['cashback', 'transfer'],
  ] as const satisfies readonly (readonly [WalletTransactionType, string])[])(
    'refuses a %s debit over the free money',
    async (type, outflow) => {
      const { userId } = await player('150');
      await grant(userId);

      await expect(
        drizzle().transaction((tx) =>
          commands().debit(tx, {
            userId,
            amount: '60',
            type,
            currency: 'USD',
            providerRef: { providerName: 'consumer', providerRefId: randomUUID() },
          }),
        ),
      ).rejects.toMatchObject({ name: 'BonusFundsLockedError', data: { outflow } });
      expectMoney(await realBalance(userId), '150', 'balance');
    },
  );

  it('never checks a bet or an admin debit against the lock', async () => {
    const { userId } = await player('150');
    await grant(userId);
    const debit = (type: 'bet' | 'manual_debit') =>
      drizzle().transaction((tx) =>
        commands().debit(tx, { userId, amount: '60', type, currency: 'USD' }),
      );

    expect(await debit('bet')).toMatchObject({ ok: true });
    expect(await debit('manual_debit')).toMatchObject({ ok: true });
  });
});

describe('a swap while a bonus runs', () => {
  it('refuses a swap over the free money and writes no out-leg', async () => {
    const { client, userId } = await btcHolder();

    const res = await swap(client, '0.01');

    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({
      message: TEST_LOCKED_FUNDS_MESSAGE,
      data: { reason: 'bonus_funds_locked', outflow: 'swap', currency: 'BTC' },
    });
    expectMoney(await realBalance(userId, 'BTC'), '0.02', 'BTC balance');
    expect(await ledgerRows(userId, 'swap_out')).toHaveLength(0);
  });

  it('settles a swap of the free money', async () => {
    const { client, userId } = await btcHolder();

    const res = await swap(client, '0.005');

    expect(res.status).toBe(200);
    expectMoney(await realBalance(userId, 'BTC'), '0.015', 'BTC balance');
  });
});

describe('hostile inputs', () => {
  const withdrawIn = (client: TestClient, amount: string, currency: string) =>
    client.post('/wallet/withdraw', { idempotencyKey: randomUUID(), amount, currency });

  it('rejects a zero, negative or malformed amount before any lock check', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    for (const amount of ['0', '-1', '-0.5', 'abc', '']) {
      expect((await withdraw(client, amount)).status, `amount "${amount}"`).toBe(400);
    }
    expectMoney(await realBalance(userId), '150', 'balance');
  });

  it('refuses a withdrawal one unit of precision over the free money', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    await expectLocked(await withdraw(client, '50.000000000000000001'), {
      locked: '100',
      free: '50',
    });
    expect((await withdraw(client, '50')).status).toBe(200);
  });

  it('applies the lock to a lowercase currency ticker', async () => {
    const { client, userId } = await player('150');
    await grant(userId);

    await expectLocked(await withdrawIn(client, '60', 'usd'), { locked: '100', free: '50' });
    expectMoney(await realBalance(userId), '150', 'balance');
  });

  it('locks only what is left when an admin debit takes the balance below the bonus cash', async () => {
    const { client, userId } = await player('150');
    await grant(userId);
    const debited = await admin().post('/wallet/manual-adjustments', {
      userId,
      direction: 'debit',
      amount: '120',
      currency: 'USD',
      reason: 'chargeback',
      idempotencyKey: randomUUID(),
    });
    expect(debited.status).toBe(200);
    expectMoney(await realBalance(userId), '30', 'balance');

    const funds = await movableFunds(userId);

    expectMoney(funds.locked, '30', 'locked');
    expectMoney(funds.free, '0', 'free');
    await expectLocked(await withdraw(client, '0.01'), { locked: '30', free: '0' });
  });

  it('ties a deposit made while a locking bonus runs into the lock', async () => {
    const { client, userId } = await player('50');
    const grantId = await grant(userId, { linked: '0', unlinked: '50' });
    await deposit(client, '100');

    expectMoney((await grantRow(grantId)).unlinkedCash, '150', 'unlinked cash');
    const funds = await movableFunds(userId);
    expectMoney(funds.locked, '150', 'locked');
    expectMoney(funds.free, '0', 'free');
    await expectLocked(await withdraw(client, '0.01'), { locked: '150', free: '0' });
  });
});
