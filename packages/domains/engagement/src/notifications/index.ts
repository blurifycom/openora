export {
  NotificationsService,
  NotificationNotFoundError,
  NotificationOwnershipError,
} from './service/notifications.service.js';
export { createNotificationsRouter } from './router/index.js';
export type { CreateNotificationInput } from './schemas/index.js';
