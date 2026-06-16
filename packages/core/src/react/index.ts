// Transport - generic over the contract the consumer composes (the SDK does not
// aggregate domains; see createClient docs).
export { createClient, type OssClient, type CreateClientOptions } from './client.js';

// React bindings - client + auth + user
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

// PAM (Player Account Management) admin hooks are a ADDONS surface (the player.*
// admin contract lives in @oss/pam player-management). They are not part of the
// free SDK; a consumer that enables PAM builds its admin hooks against the merged
// contract. See ADR-0020.

// Data hooks
export { usePaginatedList, type PaginatedListState } from './hooks/use-paginated-list.js';
export {
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from './hooks/use-event-stream.js';
// useChatStream is a domain hook - it lives in @oss/engagement/react (it uses the
// chat contract slice + the typed client). The base SDK stays domain-agnostic.
// Pluggable client-side realtime transport (consumer injects Ably/GetStream; the
// default is built-in SSE). See ADR-0007.
export {
  RealtimeClientProvider,
  useOptionalRealtimeClient,
  type RealtimeClientAdapter,
  type RealtimeClientStatus,
  type RealtimeSubscribeHandlers,
} from './context/realtime-client.js';
