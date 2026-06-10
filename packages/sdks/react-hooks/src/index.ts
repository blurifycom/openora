// Transport
export { createClient, type OssClient, type CreateClientOptions } from './client.js';
export { contract } from '@oss/orpc-contract';

// React bindings - client + auth + user
export { ApiClientProvider, useApiClient } from './context/api-client.js';
export { useOrpcClient } from './hooks/use-orpc-client.js';
export { useSession, useLogin, useLogout, useRegister } from './hooks/auth.js';
export { useCurrentUser } from './hooks/user.js';
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

// UI provider context (consumer-facing access to Button/DataTable/etc primitives)
export { UIProvider, useUI } from './ui-provider.js';

// Framework-agnostic navigation seam (host injects a Next or TanStack adapter)
export {
  NavigationProvider,
  Link,
  usePathname,
  useNavigate,
  useSearchParam,
  type NavigationAdapter,
  type NavLinkProps,
  type Navigate,
} from './navigation.js';

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

// Cross-cutting helpers for slot fills / plugin authors (ADR-0013)
export { PageContextProvider, usePageContext, useOptionalPageContext } from './page-context.js';
export { useDataExtension, dataExtensionKey } from './data-extension.js';
export { RoleGate } from './role-gate.js';
