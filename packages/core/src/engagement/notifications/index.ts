export {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from './service/notifications.service.js';
export type { CreateNotificationInput } from './contract/index.js';
export { createNotificationsRouter } from './router/index.js';
