// Transport
export { createClient, type OssClient, type CreateClientOptions } from './client.js';
export { contract } from '@oss/orpc-contract';

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
// admin contract lives in @oss-addons/player-management). They are not part of the
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
export {
  useChatStream,
  type ChatMessage,
  type UseChatStreamOptions,
  type UseChatStreamResult,
} from './hooks/use-chat-stream.js';
// Pluggable client-side realtime transport (consumer injects Ably/GetStream; the
// default is built-in SSE). See ADR-0007.
export {
  RealtimeClientProvider,
  useOptionalRealtimeClient,
  type RealtimeClientAdapter,
  type RealtimeClientStatus,
  type RealtimeSubscribeHandlers,
} from './context/realtime-client.js';
