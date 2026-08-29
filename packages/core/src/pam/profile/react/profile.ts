'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Player } from '@openora/core/contracts';
import { useOrpcQueryUtils } from '@openora/core/react';
import { profileContract, type DisplayCurrencyInfo } from '../contract/index.js';

export type PlayerProfile = Player;

export function usePlayerProfile() {
  const utils = useOrpcQueryUtils(profileContract);
  return useQuery({ ...utils.get.queryOptions(), retry: false });
}

export function useUpdatePlayerProfile() {
  const utils = useOrpcQueryUtils(profileContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.update.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: utils.get.key() }),
  });
}

export type { DisplayCurrencyInfo };

/** Effective display currency for the current player, plus the operator's supported list. */
export function useDisplayCurrency() {
  const utils = useOrpcQueryUtils(profileContract);
  return useQuery({ ...utils.getDisplayCurrency.queryOptions(), retry: false });
}

export function useSetDisplayCurrency() {
  const utils = useOrpcQueryUtils(profileContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.setDisplayCurrency.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: utils.getDisplayCurrency.key() }),
  });
}
