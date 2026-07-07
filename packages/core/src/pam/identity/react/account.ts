'use client';

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { Enable2faResult } from '@blurifycom/core/contracts';
import { useOrpcQueryUtils } from '@blurifycom/core/react';
import { identityContract } from '../contract/index.js';

export type { Enable2faResult };

type IdentityUtils = ReturnType<typeof useOrpcQueryUtils<typeof identityContract>>;

const invalidateMe = (utils: IdentityUtils, queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: utils.me.key() });

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

export function useEnable2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.enable2fa.mutationOptions(),
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
