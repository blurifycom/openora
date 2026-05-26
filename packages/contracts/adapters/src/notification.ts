// Notification-delivery seam. A vendor (eg SendGrid/SES) implements
// NotificationDeliveryAdapter; bind a concrete adapter to NOTIFICATION_DELIVERY_ADAPTER
// in the notifications module's plugin.ts.

export interface NotificationDeliveryAdapter {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export const NOTIFICATION_DELIVERY_ADAPTER = Symbol('NOTIFICATION_DELIVERY_ADAPTER');
