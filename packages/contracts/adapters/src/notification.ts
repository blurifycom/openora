// Notification-delivery seam. Custom implementation expected (no prescribed vendor).
// The notifications module ships MockNotificationDeliveryAdapter (logs to stdout) as default.
// Override via overlay: ctx.provide(NOTIFICATION_DELIVERY_ADAPTER, () => new MyAdapter())
// Load your overlay AFTER the notifications plugin in extensions.config.ts (last registration wins).
// See docs/adapters/notification.md for the full binding guide.
import { createToken, type Token } from './token.js';

export interface NotificationDeliveryAdapter {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export const NOTIFICATION_DELIVERY_ADAPTER: Token<NotificationDeliveryAdapter> = createToken(
  'NOTIFICATION_DELIVERY_ADAPTER',
);
