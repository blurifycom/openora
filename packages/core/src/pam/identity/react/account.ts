'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Enable2faResult, IdentitySuccess } from '@openora/core/contracts';
import type { Paginated } from '@openora/core/contracts/kit';
import { useOrpcQueryUtils } from '@openora/core/react';
import { identityContract, type SessionItem } from '../contract/index.js';

export type UseMySessionsResult = UseQueryResult<Paginated<SessionItem>, Error>;
export type UseRevokeMySessionResult = UseMutationResult<IdentitySuccess, Error, { id: string }>;

export type { Enable2faResult };

type IdentityUtils = ReturnType<typeof useOrpcQueryUtils<typeof identityContract>>;

const invalidateMe = (utils: IdentityUtils, queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: utils.me.key() });

export function useEnable2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.enable2fa.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useVerify2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.verify2fa.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useDisable2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.disable2fa.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useVerifyEmail() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.verifyEmail.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useUpdateProfile() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.updateProfile.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useChangePassword() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.changePassword.mutationOptions(),
    onSuccess: invalidateMe(utils, queryClient),
  });
}

export function useSendEmailVerification() {
  const utils = useOrpcQueryUtils(identityContract);
  return useMutation({
    ...utils.sendEmailVerification.mutationOptions(),
  });
}

export function useMySessions(): UseMySessionsResult {
  const utils = useOrpcQueryUtils(identityContract);
  return useQuery(utils.sessions.listMine.queryOptions({ input: {} }));
}

export function useRevokeMySession(): UseRevokeMySessionResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.sessions.revokeMine.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: utils.sessions.listMine.key() }),
  });
}
