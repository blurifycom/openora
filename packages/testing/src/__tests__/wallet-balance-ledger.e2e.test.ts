import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { DRIZZLE } from '@openora/core/server';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  ActiveCurrencySchema,
  AdminWalletTransactionSchema,
  WalletBalancesSchema,
  WalletTransactionSchema,
} from '@openora/core/wallet/contract';
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

const PlayerPageSchema = z.object({
  items: z.array(WalletTransactionSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

const AdminPageSchema = z.object({
  items: z.array(AdminWalletTransactionSchema),
  total: z.number(),
  page: z.number(),
  limit: z.number(),
});

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

  it.todo(
    'BUG: setting an active currency the operator does not offer returns 200 and stores it, the service only updates wallet.currency (packages/core/src/wallet/service/wallet.service.ts:1762)',
  );
  it('a player listing transactions sees their own rows with their status and none of another player', async () => {
    const mine = await newFundedPlayer(e2e, '100');
    const theirs = await newFundedPlayer(e2e, '40');
    const withdrawalId = await requestWithdrawalId(mine.client, mine, { amount: '10' });

    const res = await mine.client.get('/wallet/transactions?page=1&limit=50');

    expect(res.status).toBe(200);
    const page = PlayerPageSchema.parse(await res.json());
    const ownRows = await ledgerOf(mine.userId);
    const foreignIds = new Set((await ledgerOf(theirs.userId)).map((row) => row.id));
    expect(page.items.map((item) => item.id).sort()).toEqual(ownRows.map((row) => row.id).sort());
    expect(page.items.some((item) => foreignIds.has(item.id))).toBe(false);
    expect(page.total).toBe(ownRows.length);
    for (const item of page.items) {
      expect(item.status).toBe(ownRows.find((row) => row.id === item.id)?.status);
    }
    expect(page.items.find((item) => item.id === withdrawalId)).toEqual(
      expect.objectContaining({ type: 'withdrawal', amount: amountOf('10') }),
    );
  });

  it("an admin listing a player's transactions sees rows filtered by type, status and currency and paged with a matching total", async () => {
    const player = await newFundedPlayer(e2e, '100');
    await requestWithdrawalId(player.client, player, { amount: '10' });
    await requestWithdrawalId(player.client, player, { amount: '20' });
    const base = `/wallet/transactions/${player.userId}`;
    const list = async (query: string) => {
      const res = await e2e.admin.get(`${base}?${query}`);
      expect(res.status).toBe(200);
      return AdminPageSchema.parse(await res.json());
    };

    const withdrawals = await list('types[0]=withdrawal');
    const deposits = await list('types[0]=deposit&statuses[0]=completed');
    const failedDeposits = await list('types[0]=deposit&statuses[0]=failed');
    const otherCurrency = await list('currencies[0]=NOPE');
    const sameCurrency = await list(`currencies[0]=${player.currency}`);
    const firstPage = await list('page=1&limit=2');
    const secondPage = await list('page=2&limit=2');

    expect(withdrawals.total).toBe(2);
    expect(withdrawals.items.map((item) => item.type)).toEqual(['withdrawal', 'withdrawal']);
    expect(failedDeposits.total).toBe(0);
    expect(deposits.total).toBe(1);
    expect(deposits.items).toEqual([
      expect.objectContaining({ type: 'deposit', status: 'completed', amount: amountOf('100') }),
    ]);
    expect(otherCurrency).toEqual(expect.objectContaining({ total: 0, items: [] }));
    expect(sameCurrency.total).toBe(3);
    expect([firstPage.total, secondPage.total]).toEqual([3, 3]);
    expect([firstPage.items.length, secondPage.items.length]).toEqual([2, 1]);
    const paged = [...firstPage.items, ...secondPage.items].map((item) => item.id);
    expect(new Set(paged).size).toBe(3);
  });

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

  it.todo(
    'GAP: ledger immutability is only the absence of a delete or reopen route, no database guard stops an UPDATE or DELETE on a completed row (packages/core/src/wallet/schema/index.ts:149)',
  );
});
