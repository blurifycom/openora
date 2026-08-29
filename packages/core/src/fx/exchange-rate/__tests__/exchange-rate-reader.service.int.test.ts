import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { exchangeRateQuote } from '../schema/index.js';
import {
  ExchangeRateReaderService,
  exchangeRateCacheKey,
} from '../adapters/exchange-rate-reader.service.js';
import { makeCache } from '../../../testing/mock.js';

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

async function seedQuote(
  base: string,
  quote: string,
  rate: string,
  asOf = '2026-01-01T00:00:00.000Z',
) {
  await db.drizzle.db.insert(exchangeRateQuote).values({
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    providerAsOf: new Date(asOf),
  });
}

describe('ExchangeRateReaderService.getRate (real PG, no cache)', () => {
  it('returns the identity quote for the same currency on both sides without touching the table', async () => {
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    const quote = await reader.getRate('EUR', 'EUR');
    expect(quote).not.toBeNull();
    expect(quote?.rate).toBe('1.000000000000000000');
  });

  it('returns null when nothing is stored for either leg', async () => {
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });

  it('derives a cross rate as from/pivot ÷ to/pivot from stored legs', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    await seedQuote('GBP', 'USD', '1.250000000000000000');

    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    const quote = await reader.getRate('EUR', 'GBP');

    expect(quote).not.toBeNull();
    // 1.1 / 1.25 = 0.88 exactly - no float drift.
    expect(quote?.rate).toBe('0.880000000000000000');
  });

  it('returns null when only one leg is stored', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });

  it('resolves a currency against the pivot directly using the pivot leg shortcut', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    const quote = await reader.getRate('EUR', 'USD');
    expect(quote?.rate).toBe('1.100000000000000000');
  });

  it('convert() scales an amount by the derived rate', async () => {
    await seedQuote('EUR', 'USD', '2.000000000000000000');
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    expect(await reader.convert('10', 'EUR', 'USD')).toBe('20.000000000000000000');
  });

  it('convert() returns null when no rate is available', async () => {
    const reader = new ExchangeRateReaderService(db.drizzle, undefined, 'USD');
    expect(await reader.convert('10', 'EUR', 'GBP')).toBeNull();
  });
});

describe('ExchangeRateReaderService.getRate cache -> table -> null fallback order', () => {
  it('returns a cache hit without deriving from the table at all', async () => {
    const cache = makeCache();
    // No row seeded in the table for EUR/GBP - if the reader ignored the cache and
    // fell through to the table it would return null instead of this cached value.
    await cache.set(
      exchangeRateCacheKey('EUR', 'GBP'),
      { rate: '9.000000000000000000', asOf: '2026-02-01T00:00:00.000Z' },
      { ttlMs: 60_000 },
    );

    const reader = new ExchangeRateReaderService(db.drizzle, cache, 'USD');
    const quote = await reader.getRate('EUR', 'GBP');

    expect(quote).toEqual({ rate: '9.000000000000000000', asOf: '2026-02-01T00:00:00.000Z' });
  });

  it('falls back to the table on a cache miss and then warms the cache', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    await seedQuote('GBP', 'USD', '1.250000000000000000');
    const cache = makeCache();

    const reader = new ExchangeRateReaderService(db.drizzle, cache, 'USD');
    const quote = await reader.getRate('EUR', 'GBP');

    expect(quote?.rate).toBe('0.880000000000000000');
    expect(await cache.get(exchangeRateCacheKey('EUR', 'GBP'))).toEqual(quote);
  });

  it('returns null (not a throw) when both cache and table have nothing', async () => {
    const cache = makeCache();
    const reader = new ExchangeRateReaderService(db.drizzle, cache, 'USD');
    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });
});
