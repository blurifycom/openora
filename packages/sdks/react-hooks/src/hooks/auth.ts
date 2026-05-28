import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiClient } from '../context/api-client.js';

// Endpoints exposed by the OSS identity module. Better-auth lives behind these
// routes server-side; clients call these stable contract paths instead of
// reaching directly into better-auth.

export function useSession() {
  const client = useApiClient();
  return useQuery({
    queryKey: ['session'],
    queryFn: () => client.get('/identity/me').catch(() => null),
    retry: false,
  });
}

export function useCurrentUser() {
  const client = useApiClient();
  return useQuery({
    queryKey: ['me'],
    queryFn: () => client.get<{ id: string; email: string; name: string | null }>('/identity/me'),
    retry: false,
  });
}

export function useLogin() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; password: string }) => client.post('/identity/login', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session'] });
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useLogout() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => client.post('/identity/logout', {}),
    onSuccess: () => {
      queryClient.setQueryData(['session'], null);
      queryClient.removeQueries({ queryKey: ['me'] });
    },
  });
}

export function useRegister() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { email: string; password: string; name: string }) =>
      client.post('/identity/register', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}
