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

/** An ISO timestamp `ageMs` in the past. The reader ages a quote off its provider stamp. */
function agedIso(ageMs: number): string {
  return new Date(Date.now() - ageMs).toISOString();
}

async function seedQuote(
  base: string,
  quote: string,
  rate: string,
  opts: { asOf?: string; ageMs?: number } = {},
) {
  await db.drizzle.db.insert(exchangeRateQuote).values({
    baseCurrency: base,
    quoteCurrency: quote,
    rate,
    providerAsOf: new Date(opts.asOf ?? agedIso(opts.ageMs ?? 0)),
    updatedAt: new Date(),
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

function delayedProvider(rate: string, delayMs: number, asOf?: string) {
  const getRate = vi.fn(
    () =>
      new Promise<ExchangeRateQuote>((resolve) => {
        setTimeout(() => resolve({ rate, asOf: asOf ?? new Date().toISOString() }), delayMs);
      }),
  );
  return mock<ExchangeRateProvider>({ getRate });
}

/** A provider whose quote is held until the test calls `release`, so no assertion races it. */
function gatedProvider(rate: string) {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getRate = vi.fn(async (): Promise<ExchangeRateQuote> => {
    await gate;
    return { rate, asOf: new Date().toISOString() };
  });
  return { provider: mock<ExchangeRateProvider>({ getRate }), release };
}

function baseDeps(
  over: Partial<ExchangeRateReaderServiceDeps> = {},
): ExchangeRateReaderServiceDeps {
  return {
    drizzle: db.drizzle,
    pivot: 'USD',
    // Bands in minutes, not milliseconds: a quote's age is seeded in the past, so a wide band
    // costs no wall time, while a narrow one let a loaded runner age a fresh seed into soft-stale.
    freshTtlMs: 60_000,
    hardMaxAgeMs: 120_000,
    providerTimeoutMs: 150,
    ...over,
  };
}

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const SOFT_STALE_AGE_MS = 90_000;
const HARD_STALE_AGE_MS = 180_000;
const PROVIDER_DELAY_PAST_TIMEOUT_MS = 500;

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
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: SOFT_STALE_AGE_MS });
    const { provider: fiatProvider, release } = gatedProvider('1.500000000000000000');
    const reader = new ExchangeRateReaderService(
      baseDeps({ fiatProvider, providerTimeoutMs: 10_000 }),
    );

    // The provider is held for the whole call, so a reader that awaited the refresh would
    // never return here: returning at all proves the refresh stayed in the background.
    const quote = await reader.getRate('EUR', 'USD');

    expect(quote?.rate).toBe('1.100000000000000000');
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);

    release();
    // Polled, not slept: the write lands whenever the pool hands back a connection.
    await vi.waitFor(async () =>
      expect((await getRow('EUR', 'USD'))?.rate).toBe('1.500000000000000000'),
    );
  });

  it('soft-stale: a background refresh timeout is completely invisible to the caller', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: SOFT_STALE_AGE_MS });
    const fiatProvider = delayedProvider('9.000000000000000000', PROVIDER_DELAY_PAST_TIMEOUT_MS);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');
    expect(quote?.rate).toBe('1.100000000000000000');

    await wait(200);
    const row = await getRow('EUR', 'USD');
    expect(row?.rate).toBe('1.100000000000000000');
  });

  it('hard-stale: fetches synchronously, persists, and returns the fresh quote', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: HARD_STALE_AGE_MS });
    const providerAsOf = agedIso(0);
    const fiatProvider = delayedProvider('1.300000000000000000', 5, providerAsOf);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');

    expect(quote).toEqual({ rate: '1.300000000000000000', asOf: providerAsOf });
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
    const row = await getRow('EUR', 'USD');
    expect(row?.rate).toBe('1.300000000000000000');
  });

  it('hard-stale with no row at all: fetches synchronously and persists a first row', async () => {
    const fiatProvider = delayedProvider('1.400000000000000000', 5);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'USD');

    expect(quote?.rate).toBe('1.400000000000000000');
    expect((await getRow('EUR', 'USD'))?.rate).toBe('1.400000000000000000');
  });

  it('hard-stale + provider failure (throw) returns null and fails closed, without touching a stored row', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: HARD_STALE_AGE_MS });
    const fiatProvider = mock<ExchangeRateProvider>({
      getRate: vi.fn(async () => {
        throw new Error('vendor unreachable');
      }),
    });
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    expect(await reader.getRate('EUR', 'USD')).toBeNull();
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
    const providerAsOf = agedIso(0);
    // Every caller reads the row before it can join the in-flight call, so the provider must
    // outlast the slowest of three concurrent reads; 40ms did not on a loaded runner.
    const fiatProvider = delayedProvider('1.200000000000000000', 500, providerAsOf);
    const reader = new ExchangeRateReaderService(
      baseDeps({ fiatProvider, providerTimeoutMs: 5_000 }),
    );

    const [a, b, c] = await Promise.all([
      reader.getRate('EUR', 'USD'),
      reader.getRate('EUR', 'USD'),
      reader.getRate('EUR', 'USD'),
    ]);

    expect(a).toEqual({ rate: '1.200000000000000000', asOf: providerAsOf });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(fiatProvider.getRate).toHaveBeenCalledTimes(1);
  });

  it('a settled in-flight call is removed from the single-flight map so a later call fetches again', async () => {
    const fiatProvider = delayedProvider('1.200000000000000000', 5);
    const reader = new ExchangeRateReaderService(
      baseDeps({ fiatProvider, freshTtlMs: 0, hardMaxAgeMs: 50 }),
    );

    await reader.getRate('EUR', 'USD');
    await wait(80);
    await reader.getRate('EUR', 'USD');

    expect(fiatProvider.getRate).toHaveBeenCalledTimes(2);
  });
});

describe('ExchangeRateReaderService.getRate - cross-pair freshness', () => {
  it('a derived pair is only as fresh as its staler leg', async () => {
    const stalerAsOf = agedIso(SOFT_STALE_AGE_MS);
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 10 });
    await seedQuote('GBP', 'USD', '1.250000000000000000', { asOf: stalerAsOf });
    const fiatProvider = delayedProvider('1.300000000000000000', 30);
    const reader = new ExchangeRateReaderService(baseDeps({ fiatProvider }));

    const quote = await reader.getRate('EUR', 'GBP');

    expect(quote?.rate).toBe('0.880000000000000000');
    expect(quote?.asOf).toBe(stalerAsOf);

    // The staler leg refreshes in the background. Let that write land before the next
    // test truncates, or it lands after the truncate and leaves a fresh GBP/USD row.
    await vi.waitFor(async () =>
      expect((await getRow('GBP', 'USD'))?.rate).toBe('1.300000000000000000'),
    );
  });

  it('returns null when one leg is hard-stale and its fetch fails, even if the other leg is fresh', async () => {
    await seedQuote('EUR', 'USD', '1.100000000000000000', { ageMs: 10 });
    const reader = new ExchangeRateReaderService(baseDeps());

    expect(await reader.getRate('EUR', 'GBP')).toBeNull();
  });
});
