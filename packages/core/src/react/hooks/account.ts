import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { PlayerSchema } from '@blurifycom/core/contracts';
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
  UpdatePlayerProfileInput,
} from '@blurifycom/core/contracts';
import { useApiClient } from '../context/api-client.js';

export type PlayerProfile = z.infer<typeof PlayerSchema>;
export type { Enable2faResult };

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

export function useUpdateProfile() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateProfileInput) => client.patch('/identity/profile', data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['me'] }),
  });
}

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
