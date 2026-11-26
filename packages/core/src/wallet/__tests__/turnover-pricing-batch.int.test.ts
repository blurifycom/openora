import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { moneyScaleBy, type createLogger } from '@openora/core/server';
import { WalletTurnoverConfigSchema, type ExchangeRateReader } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter, makeEventBus, mock } from './support/doubles.js';
import { migrate } from '../migrate.js';
import { walletTurnover, walletTurnoverEntry } from '../schema/index.js';
import { TurnoverService } from '../service/turnover.service.js';

let db: TestDb;
const rates = new Map<string, string>();

const reader = mock<ExchangeRateReader>({
  getRate: vi.fn(async (from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : { rate, asOf: new Date().toISOString() };
  }),
  convert: vi.fn(async (amount: string, from: string) => {
    const rate = rates.get(from);
    return rate === undefined ? null : moneyScaleBy(amount, rate);
  }),
});

const logger = mock<ReturnType<typeof createLogger>>({ error: vi.fn() });

const service = () =>
  new TurnoverService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier: '1' }),
    pivotCurrency: 'USD',
    rates: reader,
    logger,
  });

const currencyCode = () => `Q${randomUUID().slice(0, 6).toUpperCase()}`;
const tail = () => randomUUID().slice(-12);

const credit = (svc: TurnoverService, userId: string, currency: string, amount: string) =>
  db.drizzle.db.transaction((tx) =>
    svc.addCredit(tx, { userId, kind: 'deposit', sourceRef: randomUUID(), currency, amount }),
  );

const turnoverOf = async (userId: string) => {
  const [row] = await db.drizzle.db
    .select()
    .from(walletTurnover)
    .where(eq(walletTurnover.userId, userId));
  return row;
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('TurnoverService pricing job', () => {
  it('opens no player transaction and looks each currency up once when nothing has a rate', async () => {
    const svc = service();
    const currencies = [currencyCode(), currencyCode()];
    for (const userId of [randomUUID(), randomUUID(), randomUUID()]) {
      for (const currency of currencies) {
        await credit(svc, userId, currency, '5');
        await credit(svc, userId, currency, '6');
      }
    }
    vi.mocked(reader.getRate).mockClear();
    const transactions = vi.spyOn(db.drizzle.db, 'transaction');

    await svc.priceAllPending();

    expect(transactions).not.toHaveBeenCalled();
    transactions.mockRestore();
    expect(
      vi
        .mocked(reader.getRate)
        .mock.calls.map(([from]) => from)
        .sort(),
    ).toEqual([...currencies].sort());
  });

  it('prices the next player when one player fails', async () => {
    const svc = service();
    const currency = currencyCode();
    const failing = `00000000-0000-4000-8000-${tail()}`;
    const next = `ffffffff-ffff-4fff-bfff-${tail()}`;
    await credit(svc, failing, currency, '99999999999999999999');
    await credit(svc, next, currency, '2');
    rates.set(currency, '1000');
    vi.mocked(logger.error).mockClear();

    await svc.priceAllPending();

    expect(await turnoverOf(failing)).toMatchObject({ pendingCount: 1 });
    expect(await turnoverOf(next)).toMatchObject({
      pendingCount: 0,
      required: '2000.000000000000000000',
    });
    expect(logger.error).toHaveBeenCalledWith(
      { userId: failing, error: expect.any(String) },
      expect.any(String),
    );
  });
});

describe('wallet_turnover_entry protection', () => {
  it('refuses rewriting an entry, moving it back to pending or deleting it', async () => {
    const svc = service();
    const userId = randomUUID();
    const entry = await credit(svc, userId, 'USD', '10');
    if (!entry) {
      throw new Error('no entry');
    }
    const byId = eq(walletTurnoverEntry.id, entry.entryId);

    await expect(
      db.drizzle.db.update(walletTurnoverEntry).set({ amount: '1' }).where(byId),
    ).rejects.toThrow();
    await expect(
      db.drizzle.db.update(walletTurnoverEntry).set({ status: 'pending' }).where(byId),
    ).rejects.toThrow();
    await expect(db.drizzle.db.delete(walletTurnoverEntry).where(byId)).rejects.toThrow();
    expect(await db.drizzle.db.select().from(walletTurnoverEntry).where(byId)).toEqual([
      expect.objectContaining({ amount: '10.000000000000000000', status: 'counted' }),
    ]);

    await svc.clear(randomUUID(), { userId, reason: 'goodwill' });
    await expect(
      db.drizzle.db.update(walletTurnoverEntry).set({ clearReason: 'rewritten' }).where(byId),
    ).rejects.toThrow();
    expect(await db.drizzle.db.select().from(walletTurnoverEntry).where(byId)).toEqual([
      expect.objectContaining({ status: 'cleared', clearReason: 'goodwill' }),
    ]);
  });
});
