import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import type { ExchangeRateProvider, ExchangeRateQuote } from '@openora/core/contracts';
import { migrate } from '../migrate.js';
import { exchangeRateQuote } from '../schema/index.js';
import {
  ExchangeRateReaderService,
  type ExchangeRateReaderServiceDeps,
} from '../adapters/exchange-rate-reader.service.js';
import { mock } from '../../../testing/mock.js';

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
  opts: { asOf?: string; ageMs?: number } = {},
) {
  const asOf = opts.asOf ?? '2026-01-01T00:00:00.000Z';
  const updatedAt = new Date(Date.now() - (opts.ageMs ?? 0));
  await db.drizzle.db.insert(exchangeRateQuote).values({
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    providerAsOf: new Date(asOf),
    updatedAt,
  });
}

async function getRow(base: string, quote: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(exchangeRateQuote)
    .where(
      and(eq(exchangeRateQuote.baseCurrency, base), eq(exchangeRateQuote.quoteCurrency, quote)),
    );
  return row ?? null;
}

function delayedProvider(rate: string, delayMs: number, asOf = '2026-06-01T00:00:00.000Z') {
  const getRate = vi.fn(
    () =>
      new Promise<ExchangeRateQuote>((resolve) => {
        setTimeout(() => resolve({ rate, asOf }), delayMs);
      }),
  );
  return mock<ExchangeRateProvider>({ getRate });
}

function baseDeps(
  over: Partial<ExchangeRateReaderServiceDeps> = {},
): ExchangeRateReaderServiceDeps {
  return {
    drizzle: db.drizzle,
    pivot: 'USD',
    freshTtlMs: 200,
    hardMaxAgeMs: 800,
    providerTimeoutMs: 150,
    ...over,
  };
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ExchangeRateReaderService.getRate - identity and cross-pair derivation', () => {
  it('returns the identity quote for the same currency on both sides without touching the table', async () => {
    const reader = new ExchangeRateReaderService(baseDeps());
    const quote = await reader.getRate('EUR', 'EUR');
    expect(quote).not.toBeNull();
    expect(quote?.rate).toBe('1.000000000000000000');
  });

  it('returns null when nothing is stored for either leg (no provider bound)', async () => {
    const reader = new ExchangeRateReaderService(baseDeps());
    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });

  it('derives a cross rate as from/pivot ÷ to/pivot from fresh stored legs, with no provider call', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    await seedQuote('GBP', 'USD', '1.250000000000000000');
    const fiatProvider = delayedProvider('9.000000000000000000', 0);

    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));
    const quote = await reader.getRate('EUR', 'GBP');

    // 1.1 / 1.25 = 0.88 exactly - no float drift.
    expect(quote?.rate).toBe('0.880000000000000000');
    expect(fiatProvider.getRate).not.toHaveBeenCalled();
  });

  it('resolves a currency against the pivot directly using the pivot leg shortcut', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000');
    const reader = new ExchangeRateReaderService(baseDeps());
    const quote = await reader.getRate('EUR', 'USD');
    expect(quote?.rate).toBe('1.100000000000000000');
  });

  it('convert() scales an amount by the derived rate', async () => {
    await seedQuote('EUR', 'USD', '2.000000000000000000');
    const reader = new ExchangeRateReaderService(baseDeps());
    expect(await reader.convert('10', 'EUR', 'USD')).toBe('20.000000000000000000');
  });

  it('convert() returns null when no rate is available', async () => {
    const reader = new ExchangeRateReaderService(baseDeps());
    expect(await reader.convert('10', 'EUR', 'GBP')).toBeNull();
  });
});

describe('ExchangeRateReaderService.getRate - age bands', () => {
  it('fresh: serves the stored quote with no provider call', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 10 });
    const fiatProvider = delayedProvider('9.000000000000000000', 0);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');

    expect(quote?.rate).toBe('1.100000000000000000');
    expect(fiatProvider.getRate).not.toHaveBeenCalled();
  });

  it('soft-stale: returns the cached value immediately and refreshes in the background', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', {
      asOf: '2026-01-01T00:00:00.000Z',
      ageMs: 400, // between freshTtlMs(200) and hardMaxAgeMs(800)
    });
    const fiatProvider = delayedProvider('1.500000000000000000', 30, '2026-06-01T00:00:00.000Z');
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const start = Date.now();
    const quote = await reader.getRate('EUR', 'USD');
    const elapsed = Date.now() - start;

    // Served the stale cached value immediately - did not wait on the provider's delay.
    expect(quote?.rate).toBe('1.100000000000000000');
    expect(elapsed).toBeLessThan(30);

    // Background refresh completes shortly after and persists the new quote.
    await wait(80);
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
    const row = await getRow('EUR', 'USD');
    expect(row?.rate).toBe('1.500000000000000000');
  });

  it('soft-stale: a background refresh timeout is completely invisible to the caller', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 400 });
    const fiatProvider = delayedProvider('9.000000000000000000', 500); // exceeds providerTimeoutMs(150)
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');
    expect(quote?.rate).toBe('1.100000000000000000');

    // Wait past the timeout window; the stored row must remain untouched, and the
    // caller never saw a rejection or a hang.
    await wait(200);
    const row = await getRow('EUR', 'USD');
    expect(row?.rate).toBe('1.100000000000000000');
  });

  it('hard-stale: fetches synchronously, persists, and returns the fresh quote', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 1_000 }); // past hardMaxAgeMs(800)
    const fiatProvider = delayedProvider('1.300000000000000000', 5, '2026-06-01T00:00:00.000Z');
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');

    expect(quote).toEqual({ rate: '1.300000000000000000', asOf: '2026-06-01T00:00:00.000Z' });
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
    const row = await getRow('EUR', 'USD');
    expect(row?.rate).toBe('1.300000000000000000');
  });

  it('hard-stale with no row at all: fetches synchronously and persists a first row', async () => {
    const fiatProvider = delayedProvider('1.400000000000000000', 5, '2026-06-01T00:00:00.000Z');
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');

    expect(quote?.rate).toBe('1.400000000000000000');
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.400000000000000000');
  });

  it('hard-stale + provider failure (throw) returns null and fails closed, without touching a stored row', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 1_000 });
    const fiatProvider = mock<ExchangeRateProvider>({
      getRate: vi.fn(async () => {
        throw new Error('vendor unreachable');
      }),
    });
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    expect(await reader.getRate('EUR', 'USD')).toBeNull();
    // The old (already hard-stale) row is left exactly as it was - a failed fetch
    // never clobbers the last-known-good value.
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.100000000000000000');
  });

  it('hard-stale + provider returning null returns null and fails closed', async () => {
    const fiatProvider = mock<ExchangeRateProvider>({ getRate: vi.fn(async () => null) });
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    expect(await reader.getRate('EUR', 'USD')).toBeNull();
  });

  it('hard-stale + no provider bound for the rail returns null and fails closed', async () => {
    const reader = new ExchangeRateReaderService(baseDeps());
    expect(await reader.getRate('EUR', 'USD')).toBeNull();
  });

  it('hard-stale: a provider call exceeding providerTimeoutMs returns null promptly (does not hang)', async () => {
    const fiatProvider = delayedProvider('9.000000000000000000', 5_000);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider, providerTimeoutMs: 30 }));

    const start = Date.now();
    const quote = await reader.getRate('EUR', 'USD');
    const elapsed = Date.now() - start;

    expect(quote).toBeNull();
    expect(elapsed).toBeLessThan(500);
  });
});

describe('ExchangeRateReaderService.getRate - single-flight', () => {
  it('collapses concurrent hard-stale callers for the same leg into one provider call', async () => {
    const fiatProvider = delayedProvider('1.200000000000000000', 40, '2026-06-01T00:00:00.000Z');
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const [a, b, c] = await Promise.all([
      reader.getRate('EUR', 'USD'),
      reader.getRate('EUR', 'USD'),
      reader.getRate('EUR', 'USD'),
    ]);

    expect(a).toEqual({ rate: '1.200000000000000000', asOf: '2026-06-01T00:00:00.000Z' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
  });

  it('a settled in-flight call is removed from the single-flight map so a later call fetches again', async () => {
    const fiatProvider = delayedProvider('1.200000000000000000', 5, '2026-06-01T00:00:00.000Z');
    // freshTtlMs: 0 and a tiny hardMaxAgeMs force every call past the just-persisted
    // row's own age band, so this isolates "the in-flight entry is cleared on
    // settle" from "a fresh row skips the provider entirely".
    const reader = new ExchangeRateReaderService(
      baseDeps({ fiatProvider, freshTtlMs: 0, hardMaxAgeMs: 10 }),
    );

    await reader.getRate('EUR', 'USD');
    await wait(30);
    await reader.getRate('EUR', 'USD');

    expect(fiatProvider.getRate).toHaveBeenCalledTimes(2);
  });
});

describe('ExchangeRateReaderService.getRate - cross-pair freshness', () => {
  it('a derived pair is only as fresh as its staler leg', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', {
      asOf: '2026-03-01T00:00:00.000Z',
      ageMs: 10, // fresh
    });
    await seedQuote('GBP', 'USD', '1.250000000000000000', {
      asOf: '2026-01-01T00:00:00.000Z', // the staler leg
      ageMs: 400, // soft-stale: served immediately, background-refreshed
    });
    const fiatProvider = delayedProvider('1.300000000000000000', 30, '2026-06-01T00:00:00.000Z');
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'GBP');

    expect(quote?.rate).toBe('0.880000000000000000');
    // Combined asOf takes the staler (GBP/USD) leg's asOf, not the fresh EUR/USD one.
    expect(quote?.asOf).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null when one leg is hard-stale and its fetch fails, even if the other leg is fresh', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 10 });
    // GBP/USD has no row at all -> hard-stale path, no provider bound -> fails closed.
    const reader = new ExchangeRateReaderService(baseDeps());

    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });
});
