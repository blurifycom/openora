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

/** Tolerated forward clock skew between the provider's `asOf` and this process. */
const MAX_PROVIDER_CLOCK_SKEW_MS = 60_000;
/** Upper bound on a plausible pivot-denominated rate; anything beyond is a provider defect. */
const MAX_PLAUSIBLE_RATE = 1e12;
/** Hard cap on the failure-cooldown map, so an unbounded code space cannot grow it. */
const MAX_FAILURE_ENTRIES = 512;

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
 * answering. Three age bands off the quote's own provider timestamp
 * (`exchange_rate_quote.providerAsOf`), never off the local write time - re-persisting
 * an old quote must not make it look fresh:
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
    // A clock ahead of ours only ever makes a quote look newer, never older, so clamp at 0.
    const ageMs = row
      ? Math.max(0, Date.now() - row.providerAsOf.getTime())
      : Number.POSITIVE_INFINITY;

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
      this.rememberFailure(currency);
      logger.error(
        { err, currency, pivot: this.pivot, hadRow: row !== null },
        'exchange rate hard-stale and unavailable; failing closed',
      );
      return null;
    }
  }

  /** Records a cooldown, evicting expired entries first so the map cannot grow without bound. */
  private rememberFailure(currency: string): void {
    const now = Date.now();
    for (const [key, until] of this.failedUntil) {
      if (until <= now) {
        this.failedUntil.delete(key);
      }
    }
    while (this.failedUntil.size >= MAX_FAILURE_ENTRIES) {
      const [oldest] = this.failedUntil.keys();
      if (oldest === undefined) {
        break;
      }
      this.failedUntil.delete(oldest);
    }
    this.failedUntil.set(currency, now + this.providerTimeoutMs);
  }

  private async readRow(currency: string): Promise<{ rate: string; providerAsOf: Date } | null> {
    const [row] = await this.drizzle.db
      .select({
        rate: exchangeRateQuote.rate,
        providerAsOf: exchangeRateQuote.providerAsOf,
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
    this.assertUsableQuote(currency, quote);

    await this.persist(currency, quote);
    return quote;
  }

  /**
   * A rate is money arithmetic: a zero, negative, absurd or unparseable one would silently
   * convert a wager to nothing and walk it past an RG limit, and a timestamp we cannot trust
   * would age wrong. Refuse before persisting, so the bad value never enters the cache.
   */
  private assertUsableQuote(currency: string, quote: ExchangeRateQuote): void {
    const pair = `${currency}/${this.pivot}`;
    const rate = Number(quote.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_PLAUSIBLE_RATE) {
      throw new Error(`exchange rate provider returned an out-of-range rate for ${pair}`);
    }
    const asOf = new Date(quote.asOf).getTime();
    if (Number.isNaN(asOf)) {
      throw new Error(`exchange rate provider returned an unparseable timestamp for ${pair}`);
    }
    const now = Date.now();
    if (asOf > now + MAX_PROVIDER_CLOCK_SKEW_MS) {
      throw new Error(`exchange rate provider returned a future timestamp for ${pair}`);
    }
    if (now - asOf >= this.hardMaxAgeMs) {
      throw new Error(`exchange rate provider returned an already hard-stale quote for ${pair}`);
    }
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
