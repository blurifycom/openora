import { DrizzleService, moneyDivide, moneyScaleBy, createLogger } from '@openora/core/server';
import type {
  ExchangeRateProvider,
  ExchangeRateQuote,
  ExchangeRateReader,
} from '@openora/core/contracts';
import { railFor } from '@openora/core/contracts';
import { and, eq } from 'drizzle-orm';
import { exchangeRateQuote } from '../schema/index.js';

const logger = createLogger('exchange-rate-reader');

export function selectProvider(
  currency: string,
  cryptoProvider: ExchangeRateProvider | undefined,
  fiatProvider: ExchangeRateProvider | undefined,
  cryptoCurrencies?: readonly string[],
): ExchangeRateProvider | undefined {
  return railFor(currency, cryptoCurrencies) === 'crypto' ? cryptoProvider : fiatProvider;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`exchange rate provider timed out fetching ${label}`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export type ExchangeRateReaderServiceDeps = {
  drizzle: DrizzleService;
  pivot: string;
  cryptoProvider?: ExchangeRateProvider;
  fiatProvider?: ExchangeRateProvider;
  cryptoCurrencies?: readonly string[];
  freshTtlMs: number;
  hardMaxAgeMs: number;
  providerTimeoutMs: number;
};

/**
 * Read-through cache in front of the two exchange-rate provider ports. A player
 * request MAY reach a vendor: a hard-stale or missing quote is fetched
 * synchronously (with a short timeout, failing closed to `null` on error) before
 * answering. Three age bands off the stored quote's own last-write time
 * (`exchange_rate_quote.updatedAt`):
 *   - fresh (age < freshTtlMs): return the stored value, no provider call.
 *   - soft-stale (freshTtlMs <= age < hardMaxAgeMs): return the stored value
 *     immediately, kick a single-flight background refresh that is invisible to
 *     the caller (its failure is logged, never thrown).
 *   - hard-stale (age >= hardMaxAgeMs) or no row at all: fetch synchronously
 *     through the same single-flight path; on success persist and return; on
 *     failure return `null`.
 * Concurrent callers for the same (currency, pivot) leg share one in-flight
 * provider call.
 */
export class ExchangeRateReaderService implements ExchangeRateReader {
  private readonly drizzle: DrizzleService;
  private readonly pivot: string;
  private readonly cryptoProvider?: ExchangeRateProvider;
  private readonly fiatProvider?: ExchangeRateProvider;
  private readonly cryptoCurrencies?: readonly string[];
  private readonly freshTtlMs: number;
  private readonly hardMaxAgeMs: number;
  private readonly providerTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<ExchangeRateQuote>>();
  private readonly failedUntil = new Map<string, number>();

  constructor(deps: ExchangeRateReaderServiceDeps) {
    this.drizzle = deps.drizzle;
    this.pivot = deps.pivot.toUpperCase();
    this.cryptoProvider = deps.cryptoProvider;
    this.fiatProvider = deps.fiatProvider;
    this.cryptoCurrencies = deps.cryptoCurrencies;
    this.freshTtlMs = deps.freshTtlMs;
    this.hardMaxAgeMs = deps.hardMaxAgeMs;
    this.providerTimeoutMs = deps.providerTimeoutMs;
  }

  async getRate(from: string, to: string): Promise<ExchangeRateQuote | null> {
    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    if (fromCode === toCode) {
      return { rate: '1.000000000000000000', asOf: new Date().toISOString() };
    }

    const [fromLeg, toLeg] = await Promise.all([
      this.resolveLeg(fromCode),
      this.resolveLeg(toCode),
    ]);
    if (!fromLeg || !toLeg) {
      return null;
    }

    const rate = moneyDivide(fromLeg.rate, toLeg.rate);
    const asOf = fromLeg.asOf < toLeg.asOf ? fromLeg.asOf : toLeg.asOf;
    return { rate, asOf };
  }

  async convert(amount: string, from: string, to: string): Promise<string | null> {
    const quote = await this.getRate(from, to);
    if (!quote) {
      return null;
    }
    return moneyScaleBy(amount, quote.rate);
  }

  private async resolveLeg(currency: string): Promise<ExchangeRateQuote | null> {
    if (currency === this.pivot) {
      return { rate: '1.000000000000000000', asOf: new Date().toISOString() };
    }

    const row = await this.readRow(currency);
    const ageMs = row ? Date.now() - row.updatedAt.getTime() : Number.POSITIVE_INFINITY;

    if (row && ageMs < this.freshTtlMs) {
      return { rate: row.rate, asOf: row.providerAsOf.toISOString() };
    }

    if (row && ageMs < this.hardMaxAgeMs) {
      void this.fetchLeg(currency).catch((err: unknown) => {
        logger.warn(
          { err, currency, pivot: this.pivot },
          'background exchange rate refresh failed',
        );
      });
      return { rate: row.rate, asOf: row.providerAsOf.toISOString() };
    }

    const cooldownUntil = this.failedUntil.get(currency);
    if (cooldownUntil !== undefined && Date.now() < cooldownUntil) {
      return null;
    }

    try {
      const quote = await this.fetchLeg(currency);
      this.failedUntil.delete(currency);
      return quote;
    } catch (err) {
      this.failedUntil.set(currency, Date.now() + this.providerTimeoutMs);
      logger.error(
        { err, currency, pivot: this.pivot, hadRow: row !== null },
        'exchange rate hard-stale and unavailable; failing closed',
      );
      return null;
    }
  }

  private async readRow(
    currency: string,
  ): Promise<{ rate: string; providerAsOf: Date; updatedAt: Date } | null> {
    const [row] = await this.drizzle.db
      .select({
        rate: exchangeRateQuote.rate,
        providerAsOf: exchangeRateQuote.providerAsOf,
        updatedAt: exchangeRateQuote.updatedAt,
      })
      .from(exchangeRateQuote)
      .where(
        and(
          eq(exchangeRateQuote.baseCurrency, currency),
          eq(exchangeRateQuote.quoteCurrency, this.pivot),
        ),
      );
    return row ?? null;
  }

  private fetchLeg(currency: string): Promise<ExchangeRateQuote> {
    const key = `${currency}:${this.pivot}`;
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const attempt = this.fetchFromProvider(currency).finally(() => {
      if (this.inFlight.get(key) === attempt) {
        this.inFlight.delete(key);
      }
    });
    this.inFlight.set(key, attempt);
    return attempt;
  }

  private async fetchFromProvider(currency: string): Promise<ExchangeRateQuote> {
    const provider = selectProvider(
      currency,
      this.cryptoProvider,
      this.fiatProvider,
      this.cryptoCurrencies,
    );
    if (!provider) {
      throw new Error(`no exchange rate provider bound for ${currency}/${this.pivot}`);
    }

    const quote = await withTimeout(
      provider.getRate(currency, this.pivot),
      this.providerTimeoutMs,
      `${currency}/${this.pivot}`,
    );
    if (!quote) {
      throw new Error(`exchange rate provider returned no quote for ${currency}/${this.pivot}`);
    }

    await this.persist(currency, quote);
    return quote;
  }

  private async persist(base: string, value: ExchangeRateQuote): Promise<void> {
    const providerAsOf = new Date(value.asOf);
    await this.drizzle.db
      .insert(exchangeRateQuote)
      .values({ baseCurrency: base, quoteCurrency: this.pivot, rate: value.rate, providerAsOf })
      .onConflictDoUpdate({
        target: [exchangeRateQuote.baseCurrency, exchangeRateQuote.quoteCurrency],
        set: { rate: value.rate, providerAsOf, updatedAt: new Date() },
      });
  }
}
