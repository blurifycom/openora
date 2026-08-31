'use client';

import { useQuery } from '@tanstack/react-query';
import { useOrpcQueryUtils } from '@openora/core/react';
import { exchangeRateContract } from '../contract/index.js';

export function useExchangeRate(from: string, to: string) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({ ...utils.getRate.queryOptions({ input: { from, to } }), retry: false });
}

export function useExchangeRates(to: string, from: readonly string[]) {
  const utils = useOrpcQueryUtils(exchangeRateContract);
  return useQuery({
    ...utils.getRates.queryOptions({ input: { to, from: [...from] } }),
    enabled: from.length > 0,
    retry: false,
  });
}
