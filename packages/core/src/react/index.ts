export { createClient, type OssClient, type CreateClientOptions } from './client.js';

export { ApiClientProvider, useApiClient } from './context/api-client.js';
export { useOrpcClient } from './hooks/use-orpc-client.js';
export { useOrpcQueryUtils } from './hooks/use-orpc-query.js';
export { usePaginatedList, type PaginatedListState } from './hooks/use-paginated-list.js';
export {
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from './hooks/use-event-stream.js';
export {
  RealtimeClientProvider,
  useOptionalRealtimeClient,
  type RealtimeClientAdapter,
  type RealtimeClientStatus,
  type RealtimeSubscribeHandlers,
} from './context/realtime-client.js';
