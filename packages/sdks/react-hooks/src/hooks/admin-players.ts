'use client';

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { PlayerSchema, PlayerStatusSchema, KycStatusSchema } from '@oss/orpc-contract';
import { useOrpcClient } from './use-orpc-client.js';

// Player Account Management (PAM) admin hooks over the `player.*` contract.
// Unlike the player-facing account hooks (which hit REST paths via useApiClient),
// these use the fully-typed oRPC client so inputs/outputs are inferred end-to-end
// from the contract - no string paths, no response casts. All routes are admin
// guarded server-side; the caller just needs an authenticated admin session.

// Canonical PAM shapes, inferred from the contract - never hand-written.
export type Player = z.infer<typeof PlayerSchema>;
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;
export type KycStatus = z.infer<typeof KycStatusSchema>;

const PLAYERS_KEY = ['admin', 'players'] as const;
const playerKey = (playerId: string) => ['admin', 'player', playerId] as const;

// Optional fields are explicitly `| undefined` so consumers compiled with
// `exactOptionalPropertyTypes` can pass `search: value || undefined` inline.
export type AdminPlayersQuery = {
  page?: number | undefined;
  limit?: number | undefined;
  search?: string | undefined;
  status?: PlayerStatus | undefined;
};

/** Paginated, searchable, status-filterable admin list of players. */
export function useAdminPlayers(query: AdminPlayersQuery = {}) {
  const client = useOrpcClient();
  return useQuery({
    queryKey: [...PLAYERS_KEY, query],
    queryFn: () => client.player.list(query),
    placeholderData: keepPreviousData,
  });
}

/** A single player by id. Disabled until an id is provided. */
export function useAdminPlayer(playerId: string | undefined) {
  const client = useOrpcClient();
  return useQuery({
    queryKey: playerKey(playerId ?? ''),
    queryFn: () => client.player.get({ playerId: playerId as string }),
    enabled: Boolean(playerId),
  });
}

type UpdateAdminPlayerInput = {
  playerId: string;
  displayName?: string;
  status?: PlayerStatus;
  kycStatus?: KycStatus;
  level?: number;
};

/** Patch displayName / status / kycStatus / level for a player. */
export function useUpdateAdminPlayer() {
  const client = useOrpcClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAdminPlayerInput) => client.player.update(input),
    onSuccess: (player) => {
      queryClient.invalidateQueries({ queryKey: PLAYERS_KEY });
      queryClient.invalidateQueries({ queryKey: playerKey(player.id) });
    },
  });
}

/** Ban / remove a player. */
export function useRemoveAdminPlayer() {
  const client = useOrpcClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (playerId: string) => client.player.remove({ playerId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PLAYERS_KEY }),
  });
}
