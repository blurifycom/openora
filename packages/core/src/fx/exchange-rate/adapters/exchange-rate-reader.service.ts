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

/**
 * Which provider (if any) a currency routes to, via the wallet module's `railFor` -
 * do not invent a second classification. Pure and unit-testable without touching a
 * database or a provider.
 */
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
  /** Age below which a stored quote is served with no provider call. */
  freshTtlMs: number;
  /** Age at/above which a stored quote (or a missing one) is fetched synchronously. */
  hardMaxAgeMs: number;
  /** Timeout on a single provider call, sync or background. */
  providerTimeoutMs: number;
};

/**
 * Read-through cache in front of the two exchange-rate provider ports, self-bound by
 * this module's plugin.ts (same pattern as WalletAssetCatalogService/WalletReaderService)
 * - an operator gets a working EXCHANGE_RATE_READER with no wiring. A player request MAY
 * reach a vendor: a hard-stale or missing quote is fetched synchronously (with a short
 * timeout, failing closed to `null` on error) before answering. Three age bands off the
 * stored quote's own last-write time (`exchange_rate_quote.updatedAt`):
 *   - fresh (age < freshTtlMs): return the stored value, no provider call.
 *   - soft-stale (freshTtlMs <= age < hardMaxAgeMs): return the stored value
 *     immediately, kick a single-flight background refresh that is completely
 *     invisible to the caller (its failure is logged, never thrown).
 *   - hard-stale (age >= hardMaxAgeMs) or no row at all: fetch synchronously through
 *     the same single-flight path; on success persist and return; on failure return
 *     `null` so a caller (a limit check, a deposit) fails closed.
 * Concurrent callers for the same (currency, pivot) leg share one in-flight provider
 * call (`fetchLeg`'s single-flight map) - without this a TTL expiry would turn one
 * refresh into as many provider calls as there are concurrent callers.
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
  // Leg -> epoch ms until which a synchronous fetch is not retried. Single-flight only
  // collapses CONCURRENT callers; a pair the provider cannot resolve at all is never
  // persisted, so without this every sequential request re-issues the vendor call. The
  // cooldown is the provider timeout, so one unresolvable currency costs at most one
  // call per timeout window instead of one per request.
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
      // Same currency: the rate is trivially 1, no table involvement, no
      // provider-sourced `asOf` to report - stamp "now" instead.
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
    // The cross pair is only as fresh as its staler leg.
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

  // Resolves one currency's rate against the pivot, applying the fresh/soft-stale/
  // hard-stale age bands to that leg's own stored row.
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
      // Soft-stale: serve the stored value now, refresh in the background. A slow
      // or dead provider must never delay this caller - failure is logged, not
      // thrown or awaited.
      void this.fetchLeg(currency).catch((err: unknown) => {
        logger.warn(
          { err, currency, pivot: this.pivot },
          'background exchange rate refresh failed',
        );
      });
      return { rate: row.rate, asOf: row.providerAsOf.toISOString() };
    }

    // Hard-stale or no row at all: fetch synchronously and fail closed on error.
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
      // Availability event: deposits/limit checks gating on this rail start being
      // refused from here. Alertable level, not silent.
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

  // Single-flight: concurrent callers for the same (currency, pivot) leg share one
  // in-flight provider call instead of each starting their own - without this, a
  // TTL expiry under load turns one refresh into hundreds of vendor calls.
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

  // No AUDIT_WRITER record: per docs/standards/audit.md, an audit entry is required
  // for a mutation that changes player, operator, money, KYC, permissions, or
  // configuration state. This upsert is market-reference-data ingestion sourced
  // from a vendor - it is none of those (it doesn't move a balance, isn't
  // operator-authored config, and doesn't touch a player). The structured
  // `logger` calls above cover observability instead.
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
