export { createClient, type OssClient, type CreateClientOptions } from './client.js';

export { ApiClientProvider, useApiClient } from './context/api-client.js';
export { useOrpcClient } from './hooks/use-orpc-client.js';
export { useSession, useLogin, useLogout, useRegister, useCurrentUser } from './hooks/auth.js';
export {
  useEnable2fa,
  useVerify2fa,
  useDisable2fa,
  useRequestPasswordReset,
  useResetPassword,
  useChangePassword,
  useSendEmailVerification,
  useVerifyEmail,
  useUpdateProfile,
  usePlayerProfile,
  useUpdatePlayerProfile,
  type Enable2faResult,
  type PlayerProfile,
} from './hooks/account.js';

export { usePaginatedList, type PaginatedListState } from './hooks/use-paginated-list.js';
export {
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from './hooks/use-event-stream.js';
// useChatStream lives in @oss/engagement/react - the base SDK stays domain-agnostic.
// Consumer injects Ably/GetStream; default is built-in SSE. See ADR-0007.
// See ADR-0020.
export {
  RealtimeClientProvider,
  useOptionalRealtimeClient,
  type RealtimeClientAdapter,
  type RealtimeClientStatus,
  type RealtimeSubscribeHandlers,
} from './context/realtime-client.js';
