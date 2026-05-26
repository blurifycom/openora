// MockNotificationDeliveryAdapter - logs to stdout, never sends real email.
// Replace via overlay with your own SMTP/SES/SendGrid/Postmark implementation.
// See docs/adapters/notification.md for the binding pattern and interface shape.
import type { NotificationDeliveryAdapter } from '@oss/adapters';

export class MockNotificationDeliveryAdapter implements NotificationDeliveryAdapter {
  async sendEmail(to: string, subject: string, _body: string): Promise<void> {
    process.stdout.write(JSON.stringify({ mock_email: true, to, subject }) + '\n');
  }
}
