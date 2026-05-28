// Transport
export { createClient, type OssClient, type CreateClientOptions } from './client.js';
export { contract } from '@oss/orpc-contract';

// React bindings - client + auth + user
export { ApiClientProvider, useApiClient } from './context/api-client.js';
export { useOrpcClient } from './hooks/use-orpc-client.js';
export { useSession, useLogin, useLogout, useRegister } from './hooks/auth.js';
export { useCurrentUser } from './hooks/user.js';

// UI provider context (consumer-facing access to Button/DataTable/etc primitives)
export { UIProvider, useUI } from './ui-provider.js';

// Data hooks
export { usePaginatedList, type PaginatedListState } from './hooks/use-paginated-list.js';
export {
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from './hooks/use-event-stream.js';
