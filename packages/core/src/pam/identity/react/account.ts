'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  Enable2faResult,
  IdentitySuccess,
  PhoneVerificationConfirmInput,
  PhoneVerificationRequestInput,
  PhoneVerificationRequestOutput,
  SecurityControls,
  SendTwoFactorOtpResult,
  SetAutoLogoutInput,
  SetLoginWithdrawalAlertsInput,
  SetRequireTwoFactorOnLoginInput,
  SetWithdrawalPinInput,
  TwoFactorDeliveryMethod,
  TwoFactorStatus,
} from '@openora/core/contracts';
import type { Paginated } from '@openora/core/contracts/kit';
import { useOrpcQueryUtils } from '@openora/core/react';
import { identityContract, type SessionItem } from '../contract/index.js';

export type UseMySessionsResult = UseQueryResult<Paginated<SessionItem>, Error>;
export type UseRevokeMySessionResult = UseMutationResult<IdentitySuccess, Error, { id: string }>;
export type UseMySecurityControlsResult = UseQueryResult<SecurityControls, Error>;
export type UseSetLoginWithdrawalAlertsResult = UseMutationResult<
  SecurityControls,
  Error,
  SetLoginWithdrawalAlertsInput
>;
export type UseSetAutoLogoutResult = UseMutationResult<SecurityControls, Error, SetAutoLogoutInput>;
export type UseSetRequireTwoFactorOnLoginResult = UseMutationResult<
  SecurityControls,
  Error,
  SetRequireTwoFactorOnLoginInput
>;
export type UseSetWithdrawalPinResult = UseMutationResult<
  SecurityControls,
  Error,
  SetWithdrawalPinInput
>;
export type UseRequestPhoneVerificationResult = UseMutationResult<
  PhoneVerificationRequestOutput,
  Error,
  PhoneVerificationRequestInput
>;
export type UseConfirmPhoneVerificationResult = UseMutationResult<
  SecurityControls,
  Error,
  PhoneVerificationConfirmInput
>;
export type UseTwoFactorStatusResult = UseQueryResult<TwoFactorStatus, Error>;
// The route takes no body, so the mutation carries no variables of its own.
export type UseSendTwoFactorOtpResult = UseMutationResult<SendTwoFactorOtpResult, Error, unknown>;

export type { Enable2faResult, TwoFactorDeliveryMethod, TwoFactorStatus };

type IdentityUtils = ReturnType<typeof useOrpcQueryUtils<typeof identityContract>>;

const invalidateMe = (utils: IdentityUtils, queryClient: QueryClient) => () =>
  queryClient.invalidateQueries({ queryKey: utils.me.key() });

const invalidateSecurityControls = (utils: IdentityUtils, queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: utils.me.key() }),
    queryClient.invalidateQueries({ queryKey: utils.security.me.key() }),
    // Enrolment state lives in its own query, so without this the Security page keeps
    // rendering the pre-enrolment controls until something else refetches it.
    queryClient.invalidateQueries({ queryKey: utils.twoFactorStatus.key() }),
  ]);

export function useEnable2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.enable2fa.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useVerify2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.verify2fa.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

// The Security page reads this rather than `me`: the active method and the masked
// destinations are 2FA state, not profile fields, and must refresh whenever enrolment
// changes without dragging the whole user object along.
export function useTwoFactorStatus(): UseTwoFactorStatusResult {
  const utils = useOrpcQueryUtils(identityContract);
  return useQuery(utils.twoFactorStatus.queryOptions());
}

export function useSendTwoFactorOtp(): UseSendTwoFactorOtpResult {
  const utils = useOrpcQueryUtils(identityContract);
  return useMutation(utils.sendTwoFactorOtp.mutationOptions());
}

export function useDisable2fa() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.disable2fa.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useVerifyEmail() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.verifyEmail.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
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
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useMySecurityControls(): UseMySecurityControlsResult {
  const utils = useOrpcQueryUtils(identityContract);
  return useQuery(utils.security.me.queryOptions());
}

export function useSetLoginWithdrawalAlerts(): UseSetLoginWithdrawalAlertsResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.security.loginWithdrawalAlerts.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useSetAutoLogout(): UseSetAutoLogoutResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.security.autoLogout.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useSetRequireTwoFactorOnLogin(): UseSetRequireTwoFactorOnLoginResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.security.requireTwoFactorOnLogin.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useSetWithdrawalPin(): UseSetWithdrawalPinResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.security.setWithdrawalPin.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useRemoveWithdrawalPin() {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.security.removeWithdrawalPin.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
  });
}

export function useRequestPhoneVerification(): UseRequestPhoneVerificationResult {
  const utils = useOrpcQueryUtils(identityContract);
  return useMutation(utils.phoneVerification.request.mutationOptions());
}

export function useConfirmPhoneVerification(): UseConfirmPhoneVerificationResult {
  const utils = useOrpcQueryUtils(identityContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.phoneVerification.confirm.mutationOptions(),
    onSuccess: invalidateSecurityControls(utils, queryClient),
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
