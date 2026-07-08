'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { PlayerSchema } from '@openora/core/contracts';
import { useOrpcQueryUtils } from '@openora/core/react';
import { profileContract } from '../contract/index.js';

export type PlayerProfile = z.infer<typeof PlayerSchema>;

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
