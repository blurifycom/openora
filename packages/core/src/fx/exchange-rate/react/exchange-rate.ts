'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrpcQueryUtils } from '@openora/core/react';
import { exchangeRateContract } from '../contract/index.js';

/** Single-pair rate read. `null` (never an error) when no rate is available yet. */
export function useExchangeRate(from: string, to: string) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({ ...utils.getRate.queryOptions({ input: { from, to } }), retry: false });
}

/**
 * Batched rate read for rendering several balances in one target currency at
 * once (eg a wallet header) - one request instead of one per source currency.
 * Each entry's `quote` is independently `null` when unavailable.
 */
export function useExchangeRates(to: string, from: readonly string[]) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({
    ...utils.getRates.queryOptions({ input: { to, from: [...from] } }),
    enabled: from.length > 0,
    retry: false,
  });
}
