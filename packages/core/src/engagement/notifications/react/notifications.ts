'use client';

import { useCallback } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type { Paginated } from '@openora/core/contracts/kit';
import {
  useEventStream,
  useOrpcClient,
  useOrpcQueryUtils,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from '@openora/core/react';
import {
  notificationsContract,
  type MarkNotificationReadOutput,
  type Notification,
  type NotificationCount,
} from '../contract/index.js';

export type UseNotificationsResult = UseQueryResult<Paginated<Notification>, Error>;
export type UseUnreadNotificationCountResult = UseQueryResult<NotificationCount, Error>;
export type UseMarkNotificationReadResult = UseMutationResult<
  MarkNotificationReadOutput,
  Error,
  { id: string }
>;
export type UseMarkAllNotificationsReadResult = UseMutationResult<
  NotificationCount,
  Error,
  unknown
>;
export type UseNotificationStreamResult = UseEventStreamResult<Notification>;

type NotificationsUtils = ReturnType<typeof useOrpcQueryUtils<typeof notificationsContract>>;

const invalidateNotifications = (utils: NotificationsUtils, queryClient: QueryClient) => () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: utils.list.key() }),
    queryClient.invalidateQueries({ queryKey: utils.unreadCount.key() }),
  ]);

export function useNotifications(
  input: { page?: number; limit?: number } = {},
): UseNotificationsResult {
  const utils = useOrpcQueryUtils(notificationsContract);
  return useQuery(utils.list.queryOptions({ input }));
}

export function useUnreadNotificationCount(): UseUnreadNotificationCountResult {
  const utils = useOrpcQueryUtils(notificationsContract);
  return useQuery(utils.unreadCount.queryOptions({ input: {} }));
}

export function useMarkNotificationRead(): UseMarkNotificationReadResult {
  const utils = useOrpcQueryUtils(notificationsContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.markRead.mutationOptions(),
    onSuccess: invalidateNotifications(utils, queryClient),
  });
}

export function useMarkAllNotificationsRead(): UseMarkAllNotificationsReadResult {
  const utils = useOrpcQueryUtils(notificationsContract);
  const queryClient = useQueryClient();
  return useMutation({
    ...utils.markAllRead.mutationOptions(),
    onSuccess: invalidateNotifications(utils, queryClient),
  });
}

export function useNotificationStream(
  options?: UseEventStreamOptions<Notification>,
): UseNotificationStreamResult {
  const client = useOrpcClient(notificationsContract);
  const subscribe = useCallback(
    (signal: AbortSignal) => client.stream(undefined, { signal }),
    [client],
  );
  return useEventStream<Notification>(subscribe, options);
}
