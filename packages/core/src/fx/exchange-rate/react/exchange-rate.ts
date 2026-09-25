'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrpcQueryUtils } from '@openora/core/react';
import { exchangeRateContract } from '../contract/index.js';

// Matches the reader's own freshTtlMs default - a mount or window refocus inside that
// window is still fresh server-side, so refetching only adds vendor-adjacent load for a
// value that hasn't changed.
const STALE_TIME_MS = 60_000;

export function useExchangeRate(from: string, to: string) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({
    ...utils.getRate.queryOptions({ input: { from, to } }),
    retry: false,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}

export function useExchangeRates(to: string, from: readonly string[]) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({
    ...utils.getRates.queryOptions({ input: { to, from: [...from] } }),
    enabled: from.length > 0,
    retry: false,
    staleTime: STALE_TIME_MS,
    refetchOnWindowFocus: false,
  });
}
