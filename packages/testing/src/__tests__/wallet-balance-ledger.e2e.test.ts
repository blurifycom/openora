import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { ActiveCurrencySchema, WalletBalancesSchema } from '@openora/core/wallet/contract';
import {
  balanceOf,
  bootWalletE2e,
  closeWalletE2e,
  newFundedPlayer,
  postWithdrawal,
  requestWithdrawalId,
  type WalletE2e,
} from './support/wallet.js';

let e2e: WalletE2e;

beforeAll(async () => {
  e2e = await bootWalletE2e();
}, 60_000);

afterAll(() => closeWalletE2e(e2e));

const amountOf = (value: string) => `${value}.000000000000000000`;

const ledgerOf = (userId: string) =>
  e2e.app.container
    .get(DRIZZLE)
    .db.select({ tx: walletTransaction })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(eq(wallet.userId, userId))
    .then((rows) => rows.map((row) => row.tx));

describe('player balances and transaction history', () => {
  it('a player reads only their own balances and active currency', async () => {
    const mine = await newFundedPlayer(e2e, '100');
    const theirs = await newFundedPlayer(e2e, '40');

    const set = await mine.client.put('/wallet/active-currency', { currency: mine.currency });
    const res = await mine.client.get('/wallet/balances');

    expect(set.status).toBe(200);
    expect(ActiveCurrencySchema.parse(await set.json())).toEqual({ activeCurrency: mine.currency });
    expect(res.status).toBe(200);
    const body = WalletBalancesSchema.parse(await res.json());
    expect(body.activeCurrency).toBe(mine.currency);
    expect(body.balances).toContainEqual({ currency: mine.currency, balance: amountOf('100') });
    expect(body.balances.map((entry) => entry.currency)).not.toContain(theirs.currency);
    const other = WalletBalancesSchema.parse(
      await (await theirs.client.get('/wallet/balances')).json(),
    );
    expect(other.balances).toContainEqual({ currency: theirs.currency, balance: amountOf('40') });
    expect(other.activeCurrency).not.toBe(mine.currency);
  });

  it.todo('a player setting an active currency the operator does not offer is refused');
  it.todo(
    'a player listing transactions sees their own rows with the status and reference conversion and none of another player',
  );

  it.todo(
    "an admin listing a player's transactions sees rows filtered by type, status and currency and paged with a matching total",
  );

  it('an unauthenticated caller reading balances or transactions is refused with 401', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const responses = await Promise.all([
      e2e.app.app.request('/wallet/balance'),
      e2e.app.app.request('/wallet/balances'),
      e2e.app.app.request('/wallet/transactions'),
      e2e.app.app.request(`/wallet/transactions/${player.userId}`),
    ]);

    expect(responses.map((res) => res.status)).toEqual([401, 401, 401, 401]);
  });

  it('a player calling an admin transaction list is refused with 403', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const victim = await newFundedPlayer(e2e, '100');

    const own = await player.client.get(`/wallet/transactions/${player.userId}`);
    const foreign = await player.client.get(`/wallet/transactions/${victim.userId}`);

    expect([own.status, foreign.status]).toEqual([403, 403]);
  });
});

describe('ledger atomicity', () => {
  it('every balance change writes a ledger row in the same transaction and a failed change leaves neither', async () => {
    const player = await newFundedPlayer(e2e, '100');
    const rowsBefore = await ledgerOf(player.userId);

    const refused = await postWithdrawal(player.client, player, { amount: '500' });
    const refusedZero = await postWithdrawal(player.client, player, { amount: '0' });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refusedZero.status).toBeGreaterThanOrEqual(400);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('100'));
    expect(await ledgerOf(player.userId)).toHaveLength(rowsBefore.length);

    const id = await requestWithdrawalId(player.client, player, { amount: '30' });

    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('70'));
    const rowsAfter = await ledgerOf(player.userId);
    expect(rowsAfter).toHaveLength(rowsBefore.length + 1);
    expect(rowsAfter.find((row) => row.id === id)).toEqual(
      expect.objectContaining({ amount: amountOf('30'), balanceAfter: amountOf('70') }),
    );
  });

  it('a ledger row records its direction and balance after the move', async () => {
    const player = await newFundedPlayer(e2e, '100');
    await requestWithdrawalId(player.client, player, { amount: '10' });
    const credit = await e2e.admin.post('/wallet/manual-adjustments', {
      userId: player.userId,
      direction: 'credit',
      currency: player.currency,
      amount: '25',
      reason: 'e2e ledger direction',
      idempotencyKey: randomUUID(),
    });
    expect(credit.status).toBe(200);

    const rows = await ledgerOf(player.userId);

    const byType = (type: string) => rows.filter((row) => row.type === type);
    expect(byType('deposit')).toEqual([
      expect.objectContaining({ direction: 'credit', balanceAfter: amountOf('100') }),
    ]);
    expect(byType('withdrawal')).toEqual([
      expect.objectContaining({ direction: 'debit', balanceAfter: amountOf('90') }),
    ]);
    expect(byType('manual_credit')).toEqual([
      expect.objectContaining({ direction: 'credit', balanceAfter: amountOf('115') }),
    ]);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('115'));
  });

  it('concurrent debits of one wallet never overspend and the balance never goes negative', async () => {
    const player = await newFundedPlayer(e2e, '100');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => postWithdrawal(player.client, player, { amount: '30' })),
    );

    const accepted = results.filter((result) => result.status === 200);
    const refused = results.filter((result) => result.status !== 200);
    expect(accepted).toHaveLength(3);
    expect(refused).toHaveLength(3);
    expect(await balanceOf(e2e, player.userId, player.currency)).toBe(amountOf('10'));
    const withdrawals = (await ledgerOf(player.userId)).filter((row) => row.type === 'withdrawal');
    expect(withdrawals).toHaveLength(3);
    expect(withdrawals.map((row) => row.balanceAfter).sort()).toEqual([
      amountOf('10'),
      amountOf('40'),
      amountOf('70'),
    ]);
  });

  it.todo('a completed ledger row cannot be reopened or deleted');
});
