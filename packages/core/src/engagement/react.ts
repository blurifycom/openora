// `@openora/core/engagement/react` - domain-owned hooks, keeping the base @openora/core/react SDK domain-agnostic.
export {
  useNotifications,
  useUnreadNotificationCount,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useNotificationStream,
  type UseNotificationsResult,
  type UseUnreadNotificationCountResult,
  type UseMarkNotificationReadResult,
  type UseMarkAllNotificationsReadResult,
  type UseNotificationStreamResult,
} from './notifications/react/notifications.js';
