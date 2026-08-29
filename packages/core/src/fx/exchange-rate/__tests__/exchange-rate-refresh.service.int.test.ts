import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { ExchangeRateProvider, ExchangeRateQuote } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { exchangeRateQuote } from '../schema/index.js';
import { ExchangeRateRefreshService } from '../service/exchange-rate-refresh.service.js';
import { exchangeRateCacheKey } from '../adapters/exchange-rate-reader.service.js';
import { mock, makeCache } from '../../../testing/mock.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(sql`TRUNCATE ${exchangeRateQuote} RESTART IDENTITY CASCADE`);
});

async function getRow(base: string, quote: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(exchangeRateQuote)
    .where(
      and(eq(exchangeRateQuote.baseCurrency, base), eq(exchangeRateQuote.quoteCurrency, quote)),
    );
  return row ?? null;
}

function fixedProvider(rate: string, asOf = '2026-01-01T00:00:00.000Z'): ExchangeRateProvider {
  return mock<ExchangeRateProvider>({
    getRate: vi.fn(async (): Promise<ExchangeRateQuote> => ({ rate, asOf })),
  });
}

describe('ExchangeRateRefreshService.runCycle (real PG)', () => {
  it('upserts a fresh row for each currency it can route and quote, split by rail', async () => {
    const cryptoProvider = fixedProvider('50000.000000000000000000');
    const fiatProvider = fixedProvider('1.100000000000000000');

    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      cryptoProvider,
      fiatProvider,
      pivot: 'USD',
      currencies: ['BTC', 'EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary).toEqual({
      considered: 2,
      refreshed: 2,
      skippedNoProvider: 0,
      skippedNoQuote: 0,
      skippedError: 0,
    });
    expect((await getRow('BTC', 'USD'))?.rate).toBe('50000.000000000000000000');
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.100000000000000000');
    expect(cryptoProvider.getRate).toHaveBeenCalledWith('BTC', 'USD');
    expect(fiatProvider.getRate).toHaveBeenCalledWith('EUR', 'USD');
  });

  it('excludes the pivot itself and dedupes/uppercases the configured currency set', async () => {
    const fiatProvider = fixedProvider('1.000000000000000000');
    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      fiatProvider,
      pivot: 'USD',
      currencies: ['usd', 'eur', 'EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary.considered).toBe(1);
    expect(summary.refreshed).toBe(1);
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
  });

  it('logs and skips a currency on its rail with no provider bound, without failing the run', async () => {
    const fiatProvider = fixedProvider('1.100000000000000000');
    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      // cryptoProvider intentionally left unbound
      fiatProvider,
      pivot: 'USD',
      currencies: ['BTC', 'EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary.skippedNoProvider).toBe(1);
    expect(summary.refreshed).toBe(1);
    expect(await getRow('BTC', 'USD')).toBeNull();
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.100000000000000000');
  });

  it('logs and skips a currency whose provider returns null, without failing the run', async () => {
    const fiatProvider = mock<ExchangeRateProvider>({ getRate: vi.fn(async () => null) });
    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      fiatProvider,
      pivot: 'USD',
      currencies: ['EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary.skippedNoQuote).toBe(1);
    expect(summary.refreshed).toBe(0);
    expect(await getRow('EUR', 'USD')).toBeNull();
  });

  it('a throwing provider for one currency does not fail the run and does not clobber a good row for another currency', async () => {
    const throwingCryptoProvider = mock<ExchangeRateProvider>({
      getRate: vi.fn(async () => {
        throw new Error('vendor unreachable');
      }),
    });
    const fiatProvider = fixedProvider('1.100000000000000000');

    // Seed a pre-existing good row for BTC that a throw must not touch.
    await db.drizzle.db.insert(exchangeRateQuote).values({
      baseCurrency: 'BTC',
      quoteCurrency: 'USD',
      rate: '40000.000000000000000000',
      providerAsOf: new Date('2025-12-01T00:00:00.000Z'),
    });

    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      cryptoProvider: throwingCryptoProvider,
      fiatProvider,
      pivot: 'USD',
      currencies: ['BTC', 'EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary.skippedError).toBe(1);
    expect(summary.refreshed).toBe(1);
    // The throw never reached the upsert - the pre-existing good row is untouched.
    expect((await getRow('BTC', 'USD'))?.rate).toBe('40000.000000000000000000');
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.100000000000000000');
  });

  it('an unbound provider for an entire run leaves every prior good row untouched', async () => {
    await db.drizzle.db.insert(exchangeRateQuote).values({
      baseCurrency: 'EUR',
      quoteCurrency: 'USD',
      rate: '1.050000000000000000',
      providerAsOf: new Date('2025-12-01T00:00:00.000Z'),
    });

    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      // Neither provider bound.
      pivot: 'USD',
      currencies: ['EUR'],
    });

    const summary = await svc.runCycle();

    expect(summary.skippedNoProvider).toBe(1);
    expect(summary.refreshed).toBe(0);
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.050000000000000000');
  });

  it('updates an existing row in place (onConflictDoUpdate) rather than duplicating it', async () => {
    const fiatProvider = fixedProvider('1.000000000000000000');
    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      fiatProvider,
      pivot: 'USD',
      currencies: ['EUR'],
    });
    await svc.runCycle();

    const svc2 = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache: undefined,
      fiatProvider: fixedProvider('1.200000000000000000', '2026-03-01T00:00:00.000Z'),
      pivot: 'USD',
      currencies: ['EUR'],
    });
    await svc2.runCycle();

    const rows = await db.drizzle.db
      .select()
      .from(exchangeRateQuote)
      .where(
        and(eq(exchangeRateQuote.baseCurrency, 'EUR'), eq(exchangeRateQuote.quoteCurrency, 'USD')),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rate).toBe('1.200000000000000000');
  });

  it('warms the read cache with the same key the reader would derive, on a successful upsert', async () => {
    const cache = makeCache();
    const fiatProvider = fixedProvider('1.100000000000000000', '2026-01-05T00:00:00.000Z');
    const svc = new ExchangeRateRefreshService({
      drizzle: db.drizzle,
      cache,
      fiatProvider,
      pivot: 'USD',
      currencies: ['EUR'],
    });

    await svc.runCycle();

    expect(await cache.get(exchangeRateCacheKey('EUR', 'USD'))).toEqual({
      rate: '1.100000000000000000',
      asOf: '2026-01-05T00:00:00.000Z',
    });
  });
});
