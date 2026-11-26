import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { ExchangeRateProvider, ExchangeRateQuote } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';
import { exchangeRateQuote } from '../schema/index.js';
import { ExchangeRateReaderService } from '../adapters/exchange-rate-reader.service.js';

const FRESH_TTL_MS = 60_000;
const HARD_MAX_AGE_MS = 3_600_000;
const CRYPTO = ['BTC', 'ETH'] as const;
const ONE = '1.000000000000000000';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

const newPivot = () => `P${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type ProviderCall = { from: string; to: string };

const recordingProvider = (
  answer: (from: string) => ExchangeRateQuote | null | Promise<ExchangeRateQuote | null>,
) => {
  const calls: ProviderCall[] = [];
  const provider: ExchangeRateProvider = {
    getRate: async (from, to) => {
      calls.push({ from, to });
      return answer(from);
    },
  };
  return { calls, provider };
};

const failingProvider = () => recordingProvider(() => Promise.reject(new Error('vendor down')));

const readerFor = (
  pivot: string,
  deps: {
    cryptoProvider?: ExchangeRateProvider;
    fiatProvider?: ExchangeRateProvider;
    providerTimeoutMs?: number;
    failureCooldownMs?: number;
  } = {},
) =>
  new ExchangeRateReaderService({
    drizzle: db.drizzle,
    pivot,
    cryptoCurrencies: CRYPTO,
    freshTtlMs: FRESH_TTL_MS,
    hardMaxAgeMs: HARD_MAX_AGE_MS,
    providerTimeoutMs: deps.providerTimeoutMs ?? 2_000,
    failureCooldownMs: deps.failureCooldownMs ?? 30_000,
    ...(deps.cryptoProvider ? { cryptoProvider: deps.cryptoProvider } : {}),
    ...(deps.fiatProvider ? { fiatProvider: deps.fiatProvider } : {}),
  });

const storeQuote = async (pivot: string, base: string, rate: string, providerAsOf: Date) => {
  await db.drizzle.db
    .insert(exchangeRateQuote)
    .values({ baseCurrency: base, quoteCurrency: pivot, rate, providerAsOf });
};

const storedQuote = async (pivot: string, base: string) => {
  const [row] = await db.drizzle.db
    .select()
    .from(exchangeRateQuote)
    .where(
      and(eq(exchangeRateQuote.baseCurrency, base), eq(exchangeRateQuote.quoteCurrency, pivot)),
    );
  return row;
};

const storedRate = async (pivot: string, base: string) =>
  (await storedQuote(pivot, base))?.rate ?? null;

const eventually = async <T>(read: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await sleep(20);
  }
};

describe('exchange-rate provider selection', () => {
  it('asks the crypto provider for a crypto currency and the fiat provider for a fiat one', async () => {
    const pivot = newPivot();
    const crypto = recordingProvider(() => ({ rate: '60000.000000000000000000', asOf: ago(0) }));
    const fiat = recordingProvider(() => ({ rate: '1.500000000000000000', asOf: ago(0) }));
    const reader = readerFor(pivot, {
      cryptoProvider: crypto.provider,
      fiatProvider: fiat.provider,
    });

    const btc = await reader.getRate('BTC', pivot);
    expect(btc?.rate).toBe('60000.000000000000000000');
    expect(crypto.calls).toEqual([{ from: 'BTC', to: pivot }]);
    expect(fiat.calls).toEqual([]);

    const eur = await reader.getRate('EUR', pivot);
    expect(eur?.rate).toBe('1.500000000000000000');
    expect(fiat.calls).toEqual([{ from: 'EUR', to: pivot }]);
    expect(crypto.calls).toHaveLength(1);
  });

  it('answers no quote when the provider for the rail is not bound', async () => {
    const pivot = newPivot();
    const crypto = recordingProvider(() => ({ rate: '2.000000000000000000', asOf: ago(0) }));
    const reader = readerFor(pivot, { cryptoProvider: crypto.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toBeNull();
    await expect(reader.convert('10.000000000000000000', 'EUR', pivot)).resolves.toBeNull();
    expect(crypto.calls).toEqual([]);
  });
});

describe('exchange-rate freshness', () => {
  it('serves a fresh cached quote without calling the provider', async () => {
    const pivot = newPivot();
    const providerAsOf = new Date(Date.now() - 5_000);
    await storeQuote(pivot, 'EUR', '1.250000000000000000', providerAsOf);
    const fiat = recordingProvider(() => ({ rate: '9.000000000000000000', asOf: ago(0) }));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toEqual({
      rate: '1.250000000000000000',
      asOf: providerAsOf.toISOString(),
    });
    await sleep(100);
    expect(fiat.calls).toEqual([]);
  });

  it('serves a soft-stale quote and refreshes it in the background', async () => {
    const pivot = newPivot();
    const staleAsOf = new Date(Date.now() - 10 * 60_000);
    await storeQuote(pivot, 'EUR', '1.250000000000000000', staleAsOf);
    const fiat = recordingProvider(() => ({ rate: '1.300000000000000000', asOf: ago(0) }));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toEqual({
      rate: '1.250000000000000000',
      asOf: staleAsOf.toISOString(),
    });
    await eventually(async () =>
      (await storedRate(pivot, 'EUR')) === '1.300000000000000000' ? true : null,
    );
    expect(fiat.calls).toEqual([{ from: 'EUR', to: pivot }]);

    await expect(reader.getRate('EUR', pivot)).resolves.toMatchObject({
      rate: '1.300000000000000000',
    });
    expect(fiat.calls).toHaveLength(1);
  });

  it('fetches from the provider when the quote is hard-stale or missing', async () => {
    const pivot = newPivot();
    await storeQuote(
      pivot,
      'EUR',
      '1.250000000000000000',
      new Date(Date.now() - 2 * HARD_MAX_AGE_MS),
    );
    const fiat = recordingProvider((from) => ({
      rate: from === 'EUR' ? '1.300000000000000000' : '0.800000000000000000',
      asOf: ago(1_000),
    }));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toMatchObject({
      rate: '1.300000000000000000',
    });
    await expect(reader.getRate('GBP', pivot)).resolves.toMatchObject({
      rate: '0.800000000000000000',
    });
    expect(fiat.calls.map((call) => call.from).sort()).toEqual(['EUR', 'GBP']);
    await eventually(async () =>
      (await storedRate(pivot, 'GBP')) === '0.800000000000000000' ? true : null,
    );
    expect(await storedRate(pivot, 'EUR')).toBe('1.300000000000000000');
  });

  it('answers no quote when the provider fails and the stored quote is hard-stale', async () => {
    const pivot = newPivot();
    await storeQuote(
      pivot,
      'EUR',
      '1.250000000000000000',
      new Date(Date.now() - 2 * HARD_MAX_AGE_MS),
    );
    const fiat = failingProvider();
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toBeNull();
    await expect(reader.convert('10.000000000000000000', 'EUR', pivot)).resolves.toBeNull();
    expect(fiat.calls).toHaveLength(1);
    expect(await storedRate(pivot, 'EUR')).toBe('1.250000000000000000');
  });

  it('answers no quote when the provider times out', async () => {
    const pivot = newPivot();
    const fiat = recordingProvider(() => new Promise<ExchangeRateQuote>(() => undefined));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider, providerTimeoutMs: 50 });

    const startedAt = Date.now();
    await expect(reader.getRate('EUR', pivot)).resolves.toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fiat.calls).toHaveLength(1);
    expect(await storedRate(pivot, 'EUR')).toBeNull();
  });

  it('rejects a provider quote whose time is further in the future than the allowed clock skew', async () => {
    const pivot = newPivot();
    const fiat = recordingProvider((from) => ({
      rate: '1.500000000000000000',
      asOf: new Date(Date.now() + (from === 'EUR' ? 120_000 : 30_000)).toISOString(),
    }));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toBeNull();
    await expect(reader.getRate('GBP', pivot)).resolves.toMatchObject({
      rate: '1.500000000000000000',
    });
    await sleep(100);
    expect(await storedRate(pivot, 'EUR')).toBeNull();
  });

  it('rejects a provider rate above the plausible upper bound or not positive', async () => {
    const pivot = newPivot();
    const rates: Record<string, string> = {
      EUR: '1000000000001',
      GBP: '0',
      CHF: '-1.5',
      PLN: 'abc',
      SEK: '1000000000000',
    };
    const fiat = recordingProvider((from) => ({ rate: rates[from] ?? '1', asOf: ago(0) }));
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', pivot)).resolves.toBeNull();
    await expect(reader.getRate('GBP', pivot)).resolves.toBeNull();
    await expect(reader.getRate('CHF', pivot)).resolves.toBeNull();
    await expect(reader.getRate('PLN', pivot)).resolves.toBeNull();
    await expect(reader.getRate('SEK', pivot)).resolves.toMatchObject({
      rate: '1000000000000.000000000000000000',
    });
    await sleep(100);
    for (const base of ['EUR', 'GBP', 'CHF', 'PLN']) {
      expect(await storedQuote(pivot, base)).toBeUndefined();
    }
  });

  it('derives the rate between two non-pivot currencies through the pivot', async () => {
    const pivot = newPivot();
    const eurAsOf = new Date(Date.now() - 5_000);
    const gbpAsOf = new Date(Date.now() - 9_000);
    await storeQuote(pivot, 'EUR', '2.000000000000000000', eurAsOf);
    await storeQuote(pivot, 'GBP', '4.000000000000000000', gbpAsOf);
    const fiat = failingProvider();
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', 'GBP')).resolves.toEqual({
      rate: '0.500000000000000000',
      asOf: gbpAsOf.toISOString(),
    });
    await expect(reader.getRate('GBP', 'EUR')).resolves.toMatchObject({
      rate: '2.000000000000000000',
    });
    await expect(reader.getRate(pivot, 'EUR')).resolves.toMatchObject({
      rate: '0.500000000000000000',
    });
    await expect(reader.getRate('EUR', pivot)).resolves.toMatchObject({
      rate: '2.000000000000000000',
    });
    await expect(reader.convert('10.000000000000000000', 'EUR', 'GBP')).resolves.toBe(
      '5.000000000000000000',
    );
    await expect(reader.getRate('EUR', 'CHF')).resolves.toBeNull();
    expect(fiat.calls.every((call) => call.from === 'CHF')).toBe(true);
  });

  it('returns rate one for the same currency', async () => {
    const pivot = newPivot();
    const fiat = failingProvider();
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    await expect(reader.getRate('EUR', 'eur')).resolves.toMatchObject({ rate: ONE });
    await expect(reader.getRate(pivot, pivot)).resolves.toMatchObject({ rate: ONE });
    await expect(reader.convert('12.340000000000000000', 'EUR', 'EUR')).resolves.toBe(
      '12.340000000000000000',
    );
    expect(fiat.calls).toEqual([]);
  });
});

describe('concurrent exchange-rate reads', () => {
  it('many parallel reads of one cold pair call the provider once', async () => {
    const pivot = newPivot();
    const fiat = recordingProvider(async () => {
      await sleep(100);
      return { rate: '1.300000000000000000', asOf: ago(0) };
    });
    const reader = readerFor(pivot, { fiatProvider: fiat.provider });

    const quotes = await Promise.all(
      Array.from({ length: 25 }, () => reader.getRate('EUR', pivot)),
    );

    expect(quotes.every((quote) => quote?.rate === '1.300000000000000000')).toBe(true);
    expect(fiat.calls).toHaveLength(1);
  });
});
