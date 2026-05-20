export interface NotificationDeliveryPort {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
}

export const NOTIFICATION_DELIVERY_PORT = Symbol('NOTIFICATION_DELIVERY_PORT');
