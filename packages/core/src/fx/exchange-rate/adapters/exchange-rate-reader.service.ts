import {
  DrizzleService,
  moneyDivide,
  moneyScaleBy,
  cached,
  createLogger,
} from '@openora/core/server';
import type { CacheAdapter, ExchangeRateQuote, ExchangeRateReader } from '@openora/core/contracts';
import { and, eq } from 'drizzle-orm';
import { exchangeRateQuote } from '../schema/index.js';

const logger = createLogger('exchange-rate-reader');

// Fallback TTL for a derived (cross) pair. The refresh job also warms this same
// namespace directly with a fresh value on every cycle (see
// ExchangeRateRefreshService), so this TTL only matters when the job hasn't run
// recently - it re-derives from the last-known-good table row, never from a
// provider, so a long TTL costs nothing but a slightly stale cache entry.
const READ_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export function exchangeRateCacheKey(from: string, to: string): string {
  return `fx:${from.toUpperCase()}:${to.toUpperCase()}`;
}

/**
 * Default DB-backed reader, self-bound by this module's plugin.ts (same pattern as
 * WalletAssetCatalogService / WalletReaderService) - an operator gets a working
 * EXCHANGE_RATE_READER with no wiring. NEVER calls a provider: cache hit -> return;
 * cache miss -> read the last-known-good row(s) from `exchange_rate_quote`, warm the
 * cache, return; nothing stored -> return `null`. Never throws, never blocks on a
 * network call - see the port's doc comment.
 */
export class ExchangeRateReaderService implements ExchangeRateReader {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly cache: CacheAdapter | undefined,
    private readonly pivot: string,
  ) {}

  async getRate(from: string, to: string): Promise<ExchangeRateQuote | null> {
    const fromCode = from.toUpperCase();
    const toCode = to.toUpperCase();
    if (fromCode === toCode) {
      // Same currency: the rate is trivially 1, no cache/table involvement, no
      // provider-sourced `asOf` to report - stamp "now" instead.
      return { rate: '1.000000000000000000', asOf: new Date().toISOString() };
    }

    return cached(this.cache, exchangeRateCacheKey(fromCode, toCode), READ_CACHE_TTL_MS, () =>
      this.deriveFromTable(fromCode, toCode),
    );
  }

  async convert(amount: string, from: string, to: string): Promise<string | null> {
    const quote = await this.getRate(from, to);
    if (!quote) {
      return null;
    }
    return moneyScaleBy(amount, quote.rate);
  }

  // Reads the last-known-good currency-vs-pivot row(s) and derives the requested
  // pair as `from/pivot ÷ to/pivot` (see the fx module's cross-pair design). The
  // pivot itself never needs a stored row: its rate against itself is always 1.
  private async deriveFromTable(
    fromCode: string,
    toCode: string,
  ): Promise<ExchangeRateQuote | null> {
    const pivot = this.pivot.toUpperCase();
    const [fromLeg, toLeg] = await Promise.all([
      this.legAgainstPivot(fromCode, pivot),
      this.legAgainstPivot(toCode, pivot),
    ]);
    if (!fromLeg || !toLeg) {
      return null;
    }

    const rate = moneyDivide(fromLeg.rate, toLeg.rate);
    // The cross pair is only as fresh as its staler leg.
    const asOf = fromLeg.asOf < toLeg.asOf ? fromLeg.asOf : toLeg.asOf;
    return { rate, asOf };
  }

  private async legAgainstPivot(
    currency: string,
    pivot: string,
  ): Promise<ExchangeRateQuote | null> {
    if (currency === pivot) {
      return { rate: '1.000000000000000000', asOf: new Date().toISOString() };
    }
    const [row] = await this.drizzle.db
      .select({ rate: exchangeRateQuote.rate, providerAsOf: exchangeRateQuote.providerAsOf })
      .from(exchangeRateQuote)
      .where(
        and(
          eq(exchangeRateQuote.baseCurrency, currency),
          eq(exchangeRateQuote.quoteCurrency, pivot),
        ),
      );
    if (!row) {
      logger.debug({ currency, pivot }, 'no stored exchange rate quote');
      return null;
    }
    return { rate: row.rate, asOf: row.providerAsOf.toISOString() };
  }
}
