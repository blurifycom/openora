'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOrpcQueryUtils } from '@blurifycom/core/react';
import { identityContract } from '../contract/index.js';

export function useCurrentUser() {
  const utils = useOrpcQueryUtils(identityContract);
  return useQuery({ ...utils.me.queryOptions(), retry: false });
}

export function useLogin() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.login.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: utils.me.key() }),
  });
}

export function useLogout() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.logout.mutationOptions(),
    onSuccess: () => queryClient.setQueryData(utils.me.queryKey(), null),
  });
}

export function useRegister() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.register.mutationOptions(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: utils.me.key() }),
  });
}

export function useRequestPasswordReset() {
  const utils = useOrpcQueryUtils(identityContract);
  return useMutation({
    ...utils.requestPasswordReset.mutationOptions(),
  });
}

export function useResetPassword() {
  const utils = useOrpcQueryUtils(identityContract);
  return useMutation({
    ...utils.resetPassword.mutationOptions(),
  });
}
