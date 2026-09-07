import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import type { SwapAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { mock, makeEventBus } from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction } from '../schema/index.js';
import { InsufficientBalanceError } from '../service/wallet.service.js';
import { SwapPairUnsupportedError, SwapService } from '../service/swap.service.js';

let db: TestDb;

const QUOTE = {
  quoteId: 'q1',
  fromCurrency: 'USD',
  toCurrency: 'BTC',
  fromAmount: '100',
  toAmount: '0.00152',
  rate: '0.0000153',
  fee: '0.0000153',
  feeCurrency: 'BTC',
  asOf: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T00:15:00.000Z',
};

function makeAdapter(overrides: Partial<SwapAdapter> = {}) {
  return mock<SwapAdapter>({
    getQuote: vi.fn().mockResolvedValue(QUOTE),
    execute: vi
      .fn()
      .mockResolvedValue({ externalId: 'ext-1', status: 'completed', toAmount: '0.00152' }),
    ...overrides,
  });
}

function makeService(adapter: SwapAdapter = makeAdapter(), events = makeEventBus()) {
  return new SwapService({ drizzle: db.drizzle, events, adapter });
}

async function seedWallet(balances: Record<string, string> = { USD: '100' }) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD' })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  for (const [currency, amount] of Object.entries(balances)) {
    await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount });
  }
  return row;
}

async function balancesOf(walletId: string) {
  const rows = await db.drizzle.db
    .select({ currency: walletBalance.currency, amount: walletBalance.amount })
    .from(walletBalance)
    .where(eq(walletBalance.walletId, walletId));
  return Object.fromEntries(rows.map((r) => [r.currency, Number(r.amount)]));
}

async function legs(walletId: string) {
  const rows = await db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
  return rows.map((r) => ({
    type: r.type,
    amount: Number(r.amount),
    currency: r.currency,
    status: r.status,
    direction: r.direction,
  }));
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('SwapService (real PG)', () => {
  it('books both legs and moves both balances on a filled swap', async () => {
    const w = await seedWallet();
    const events = makeEventBus();

    const result = await makeService(makeAdapter(), events).swap({
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey: randomUUID(),
    });

    expect(result).toMatchObject({ status: 'completed', toAmount: '0.00152' });
    expect(await balancesOf(w.id)).toEqual({ USD: 0, BTC: 0.00152 });
    expect(await legs(w.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'swap_out',
          currency: 'USD',
          status: 'completed',
          direction: 'debit',
        }),
        expect.objectContaining({
          type: 'swap_in',
          currency: 'BTC',
          status: 'completed',
          direction: 'credit',
        }),
      ]),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.swap.completed',
      expect.objectContaining({ userId: w.userId, toCurrency: 'BTC', toAmount: '0.00152' }),
    );
  });

  it('credits the filled amount, never the quoted one', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter({
      execute: vi
        .fn()
        .mockResolvedValue({ externalId: 'ext-2', status: 'completed', toAmount: '0.001' }),
    });

    await makeService(adapter).swap({
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey: randomUUID(),
    });

    expect(await balancesOf(w.id)).toEqual({ USD: 0, BTC: 0.001 });
  });

  it('holds the funds before the vendor is called and returns them when it refuses', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter({
      execute: vi.fn().mockImplementation(async () => {
        // Mid-flight: the hold must already be committed and the balance gone.
        expect(await balancesOf(w.id)).toEqual({ USD: 0 });
        throw new Error('desk unavailable');
      }),
    });

    await expect(
      makeService(adapter).swap({
        userId: w.userId,
        fromCurrency: 'USD',
        toCurrency: 'BTC',
        fromAmount: '100',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow('desk unavailable');

    expect(await balancesOf(w.id)).toEqual({ USD: 100 });
    expect(await legs(w.id)).toEqual([
      expect.objectContaining({ type: 'swap_out', status: 'failed' }),
    ]);
  });

  it('refuses a swap the balance cannot cover, without writing a hold', async () => {
    const w = await seedWallet({ USD: '10' });
    const adapter = makeAdapter();

    await expect(
      makeService(adapter).swap({
        userId: w.userId,
        fromCurrency: 'USD',
        toCurrency: 'BTC',
        fromAmount: '100',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    expect(adapter.execute).not.toHaveBeenCalled();
    expect(await legs(w.id)).toEqual([]);
    expect(await balancesOf(w.id)).toEqual({ USD: 10 });
  });

  it('trades once for a replayed idempotency key', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter();
    const svc = makeService(adapter);
    const idempotencyKey = randomUUID();
    const args = {
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey,
    };

    await svc.swap(args);
    const replay = await svc.swap(args);

    expect(replay.status).toBe('completed');
    expect(adapter.execute).toHaveBeenCalledOnce();
    expect(await balancesOf(w.id)).toEqual({ USD: 0, BTC: 0.00152 });
  });

  it('leaves an async fill processing until the vendor webhook settles it', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter({
      execute: vi.fn().mockResolvedValue({ externalId: 'ext-3', status: 'processing' }),
    });
    const svc = makeService(adapter);

    const result = await svc.swap({
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey: randomUUID(),
    });

    expect(result).toMatchObject({ status: 'processing', toAmount: null });
    expect(await balancesOf(w.id)).toEqual({ USD: 0 });

    await svc.reconcileSwapStatus({
      kind: 'swap',
      externalId: 'ext-3',
      status: 'completed',
      toAmount: '0.0014',
    });

    expect(await balancesOf(w.id)).toEqual({ USD: 0, BTC: 0.0014 });
    // A duplicate delivery must not credit the fill twice.
    await svc.reconcileSwapStatus({
      kind: 'swap',
      externalId: 'ext-3',
      status: 'completed',
      toAmount: '0.0014',
    });
    expect(await balancesOf(w.id)).toEqual({ USD: 0, BTC: 0.0014 });
  });

  it('returns the held funds when the vendor reports the swap failed', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter({
      execute: vi.fn().mockResolvedValue({ externalId: 'ext-4', status: 'processing' }),
    });
    const svc = makeService(adapter);
    await svc.swap({
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey: randomUUID(),
    });

    await svc.reconcileSwapStatus({ kind: 'swap', externalId: 'ext-4', status: 'failed' });

    expect(await balancesOf(w.id)).toEqual({ USD: 100 });
    expect(await legs(w.id)).toEqual([
      expect.objectContaining({ type: 'swap_out', status: 'failed' }),
    ]);
  });

  it('refuses a pair the vendor does not make and a swap into the same currency', async () => {
    const w = await seedWallet();
    const adapter = makeAdapter({ supportsPair: vi.fn().mockReturnValue(false) });
    const args = {
      userId: w.userId,
      fromCurrency: 'USD',
      toCurrency: 'BTC',
      fromAmount: '100',
      idempotencyKey: randomUUID(),
    };

    await expect(makeService(adapter).swap(args)).rejects.toBeInstanceOf(SwapPairUnsupportedError);
    await expect(makeService().swap({ ...args, toCurrency: 'usd' })).rejects.toBeInstanceOf(
      SwapPairUnsupportedError,
    );
  });
});
