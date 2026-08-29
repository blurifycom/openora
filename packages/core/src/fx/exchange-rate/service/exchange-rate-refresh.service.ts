import * as z from 'zod';
import { DrizzleService, createLogger } from '@openora/core/server';
import {
  queue,
  railFor,
  type CacheAdapter,
  type ExchangeRateProvider,
  type ExchangeRateQuote,
} from '@openora/core/contracts';
import { exchangeRateQuote } from '../schema/index.js';
import { exchangeRateCacheKey } from '../adapters/exchange-rate-reader.service.js';

const logger = createLogger('exchange-rate-refresh');

export const EXCHANGE_RATE_REFRESH_QUEUE = queue('exchange-rate.refresh');
export const ExchangeRateRefreshJobPayloadSchema = z.object({});
export type ExchangeRateRefreshJobPayload = z.infer<typeof ExchangeRateRefreshJobPayloadSchema>;

// Mirrors ExchangeRateReaderService's READ_CACHE_TTL_MS - the job warms the exact
// cache entry a reader would derive itself, so the reader never re-reads the table
// right after a fresh refresh.
const REFRESH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export type ExchangeRateRefreshSummary = {
  considered: number;
  refreshed: number;
  skippedNoProvider: number;
  skippedNoQuote: number;
  skippedError: number;
};

/**
 * Which provider (if any) a currency routes to this cycle, via the wallet module's
 * `railFor` - do not invent a second classification. Pure and unit-testable without
 * touching a database or a provider.
 */
export function selectProvider(
  currency: string,
  cryptoProvider: ExchangeRateProvider | undefined,
  fiatProvider: ExchangeRateProvider | undefined,
  cryptoCurrencies?: readonly string[],
): ExchangeRateProvider | undefined {
  return railFor(currency, cryptoCurrencies) === 'crypto' ? cryptoProvider : fiatProvider;
}

export type ExchangeRateRefreshServiceDeps = {
  drizzle: DrizzleService;
  cache?: CacheAdapter;
  cryptoProvider?: ExchangeRateProvider;
  fiatProvider?: ExchangeRateProvider;
  pivot: string;
  currencies: readonly string[];
  cryptoCurrencies?: readonly string[];
};

/**
 * Owns the exchange-rate refresh cron: walks the operator's configured currency set,
 * routes each currency to the crypto or fiat provider via `railFor`, and upserts the
 * result into `exchange_rate_quote` plus the read cache. A provider that is unbound,
 * throws, or returns `null` is logged and skipped - it never fails the whole cycle
 * and never overwrites a good stored row with nothing (the upsert only runs on a
 * successful quote). Only this job ever calls a provider - see the port doc comments.
 *
 * No AUDIT_WRITER record: per docs/standards/audit.md, an audit entry is required for
 * a mutation that changes player, operator, money, KYC, permissions, or configuration
 * state. This upsert is market-reference-data ingestion sourced from a vendor on a
 * timer - it is none of those (it doesn't move a balance, isn't operator-authored
 * config, and doesn't touch a player). Structured `logger` calls above cover
 * observability instead.
 */
export class ExchangeRateRefreshService {
  private readonly drizzle: DrizzleService;
  private readonly cache?: CacheAdapter;
  private readonly cryptoProvider?: ExchangeRateProvider;
  private readonly fiatProvider?: ExchangeRateProvider;
  private readonly pivot: string;
  private readonly currencies: readonly string[];
  private readonly cryptoCurrencies?: readonly string[];

  constructor(deps: ExchangeRateRefreshServiceDeps) {
    this.drizzle = deps.drizzle;
    this.cache = deps.cache;
    this.cryptoProvider = deps.cryptoProvider;
    this.fiatProvider = deps.fiatProvider;
    this.pivot = deps.pivot;
    this.currencies = deps.currencies;
    this.cryptoCurrencies = deps.cryptoCurrencies;
  }

  async runCycle(): Promise<ExchangeRateRefreshSummary> {
    const pivot = this.pivot.toUpperCase();
    const currencies = [...new Set(this.currencies.map((c) => c.toUpperCase()))].filter(
      (c) => c !== pivot,
    );

    const summary: ExchangeRateRefreshSummary = {
      considered: currencies.length,
      refreshed: 0,
      skippedNoProvider: 0,
      skippedNoQuote: 0,
      skippedError: 0,
    };

    for (const currency of currencies) {
      const provider = selectProvider(
        currency,
        this.cryptoProvider,
        this.fiatProvider,
        this.cryptoCurrencies,
      );
      if (!provider) {
        summary.skippedNoProvider += 1;
        logger.warn({ currency, pivot }, 'no exchange rate provider bound for rail; skipping');
        continue;
      }

      let quote: ExchangeRateQuote | null;
      try {
        quote = await provider.getRate(currency, pivot);
      } catch (err) {
        summary.skippedError += 1;
        logger.warn({ err, currency, pivot }, 'exchange rate provider threw; skipping');
        continue;
      }
      if (!quote) {
        summary.skippedNoQuote += 1;
        logger.warn({ currency, pivot }, 'exchange rate provider returned no quote; skipping');
        continue;
      }

      await this.upsert(currency, pivot, quote);
      summary.refreshed += 1;
    }

    return summary;
  }

  private async upsert(base: string, quote: string, value: ExchangeRateQuote): Promise<void> {
    const providerAsOf = new Date(value.asOf);
    await this.drizzle.db
      .insert(exchangeRateQuote)
      .values({ baseCurrency: base, quoteCurrency: quote, rate: value.rate, providerAsOf })
      .onConflictDoUpdate({
        target: [exchangeRateQuote.baseCurrency, exchangeRateQuote.quoteCurrency],
        set: { rate: value.rate, providerAsOf, updatedAt: new Date() },
      });

    if (!this.cache) {
      return;
    }
    try {
      await this.cache.set(
        exchangeRateCacheKey(base, quote),
        { rate: value.rate, asOf: value.asOf },
        { ttlMs: REFRESH_CACHE_TTL_MS },
      );
    } catch (err) {
      logger.warn({ err, base, quote }, 'exchange rate cache warm failed');
    }
  }
}
