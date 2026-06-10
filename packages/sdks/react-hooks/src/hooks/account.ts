import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import type {
  Enable2faInput,
  Enable2faResult,
  Verify2faInput,
  Disable2faInput,
  RequestPasswordResetInput,
  ResetPasswordInput,
  ChangePasswordInput,
  VerifyEmailInput,
  UpdateProfileInput,
} from '@oss/shared-schemas';
import { PlayerSchema, type UpdatePlayerProfileInput } from '@oss/orpc-contract';
import { useApiClient } from '../context/api-client.js';

// Account-management hooks over the identity + profile contract routes:
// two-factor (TOTP), password reset/change, email verification, and the
// player-facing self profile. Inputs/outputs are inferred from the contract
// and shared schemas - no hand-written shapes. Like the auth hooks, these call
// the stable contract paths rather than reaching into better-auth directly.

// The canonical player shape, inferred from the contract output schema.
export type PlayerProfile = z.infer<typeof PlayerSchema>;
export type { Enable2faResult };

// --- Two-factor (TOTP) ---

export function useEnable2fa() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (data: Enable2faInput) =>
      client.post<Enable2faResult>('/identity/2fa/enable', data),
  });
}

export function useVerify2fa() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Verify2faInput) => client.post('/identity/2fa/verify', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useDisable2fa() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Disable2faInput) => client.post('/identity/2fa/disable', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

// --- Password reset / change ---

export function useRequestPasswordReset() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (data: RequestPasswordResetInput) => client.post('/identity/password/forgot', data),
  });
}

export function useResetPassword() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (data: ResetPasswordInput) => client.post('/identity/password/reset', data),
  });
}

export function useChangePassword() {
  const client = useApiClient();
  return useMutation({
    mutationFn: (data: ChangePasswordInput) => client.post('/identity/password/change', data),
  });
}

// --- Email verification ---

export function useSendEmailVerification() {
  const client = useApiClient();
  return useMutation({
    mutationFn: () => client.post('/identity/email/verify/send', {}),
  });
}

export function useVerifyEmail() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: VerifyEmailInput) => client.post('/identity/email/verify', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

// --- Profile (identity: name/avatar) ---

export function useUpdateProfile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProfileInput) => client.patch('/identity/profile', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

// --- Player profile preferences (display name / country / currency / language) ---

export function usePlayerProfile() {
  const client = useApiClient();
  return useQuery({
    queryKey: ['profile'],
    queryFn: () => client.get<PlayerProfile>('/profile'),
    retry: false,
  });
}

export function useUpdatePlayerProfile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdatePlayerProfileInput) => client.patch<PlayerProfile>('/profile', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profile'] }),
  });
}
