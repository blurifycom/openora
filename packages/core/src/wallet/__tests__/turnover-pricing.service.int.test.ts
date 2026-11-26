import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { moneyCompare, moneyScaleBy } from '@openora/core/server';
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

const service = (multiplier = '1') =>
  new TurnoverService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    audit: makeAuditWriter(),
    config: WalletTurnoverConfigSchema.parse({ multiplier, creditTypes: ['deposit', 'gift'] }),
    pivotCurrency: 'USD',
    rates: reader,
  });

const unratedCurrency = () => `Q${randomUUID().slice(0, 6).toUpperCase()}`;

const turnoverOf = async (userId: string) => {
  const [row] = await db.drizzle.db
    .select()
    .from(walletTurnover)
    .where(eq(walletTurnover.userId, userId));
  return row;
};

const expectMoney = (actual: string | undefined, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

const credit = (svc: TurnoverService, userId: string, currency: string, amount = '10') =>
  db.drizzle.db.transaction((tx) =>
    svc.addCredit(tx, { userId, kind: 'deposit', sourceRef: randomUUID(), currency, amount }),
  );

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

describe('TurnoverService pending pricing', () => {
  it('raises required once however many runs price the same entries at the same time', async () => {
    const svc = service('2');
    const userId = randomUUID();
    const currency = unratedCurrency();
    await credit(svc, userId, currency, '10');
    await credit(svc, userId, currency, '5');
    expect(await turnoverOf(userId)).toMatchObject({ pendingCount: 2 });
    rates.set(currency, '3');

    const priced = await Promise.all(
      Array.from({ length: 4 }, () =>
        db.drizzle.db.transaction((tx) => svc.pricePending(tx, userId)),
      ),
    );
    await Promise.all([svc.priceAllPending(), svc.priceAllPending()]);
    await svc.priceAllPending();

    expect(priced.reduce((sum, n) => sum + n, 0)).toBe(2);
    const row = await turnoverOf(userId);
    expectMoney(row?.required, '90', 'required');
    expect(row?.pendingCount).toBe(0);
    const entries = await db.drizzle.db
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, userId));
    expect(entries.map((e) => e.status)).toEqual(['counted', 'counted']);
  });

  it('looks a rate up once per currency however many entries it prices', async () => {
    const svc = service();
    const userId = randomUUID();
    const currency = unratedCurrency();
    for (const amount of ['1', '2', '3']) {
      await credit(svc, userId, currency, amount);
    }
    rates.set(currency, '2');
    vi.mocked(reader.getRate).mockClear();

    expect(await db.drizzle.db.transaction((tx) => svc.pricePending(tx, userId))).toBe(3);

    expect(vi.mocked(reader.getRate).mock.calls.filter(([from]) => from === currency)).toHaveLength(
      1,
    );
    expectMoney((await turnoverOf(userId))?.required, '12', 'required');
  });

  it('leaves an entry pending while its currency still has no rate', async () => {
    const svc = service();
    const userId = randomUUID();
    const rated = unratedCurrency();
    const unrated = unratedCurrency();
    await credit(svc, userId, rated, '4');
    await credit(svc, userId, unrated, '7');
    rates.set(rated, '1');

    await svc.priceAllPending();

    const row = await turnoverOf(userId);
    expectMoney(row?.required, '4', 'required');
    expect(row?.pendingCount).toBe(1);
  });

  it('touches nothing at multiplier 0', async () => {
    const svc = service('0');
    const userId = randomUUID();

    expect(await credit(svc, userId, 'USD')).toBeNull();
    await svc.priceAllPending();

    expect(await turnoverOf(userId)).toBeUndefined();
  });
});
